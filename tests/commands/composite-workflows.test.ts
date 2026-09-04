import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleFileCommand } from "../../src/commands/file.js";
import { handleProjectCommand } from "../../src/commands/project.js";
import { writeCredentialsFile } from "../../src/core/auth/credentials.js";
import { writeLinearConfigFile } from "../../src/core/config/config-file.js";
import { GraphQLTransportError, type FetchLike } from "../../src/core/transport/graphql.js";

const assetUrl = "https://uploads.linear.app/existing-asset.txt";
const project = { id: "existing-project", name: "Existing", url: "https://linear.app/project/existing", teams: { nodes: [] } };
const uploadFile = { assetUrl, uploadUrl: "https://storage.example.com/upload", headers: [{ key: "signed-secret", value: "do-not-expose" }] };
const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

const failures = [
  { name: "GraphQL authentication", category: "authentication", exit: 2,
    respond: () => jsonResponse({ errors: [{ message: "Expired", path: ["mutation"], extensions: { code: "UNAUTHENTICATED" } }] }) },
  { name: "GraphQL rate limit", category: "rate-limit", exit: 3,
    respond: () => jsonResponse({ errors: [{ message: "Slow down", extensions: { code: "RATE_LIMITED", retryAfter: 30 } }] }) },
  { name: "HTTP authentication", category: "authentication", exit: 2,
    respond: () => jsonResponse({}, 401) },
  { name: "HTTP rate limit", category: "rate-limit", exit: 3,
    respond: () => jsonResponse({}, 429) },
  { name: "transport exception", category: "general", exit: 1,
    respond: (): Response => { throw new TypeError("fetch failed"); } },
  { name: "structured transport exception", category: "general", exit: 1,
    respond: (): Response => { throw new GraphQLTransportError("Connection lost", "http", 502, undefined, { requestId: "req-123" }); } },
  { name: "not found", category: "not-found", exit: 4,
    respond: () => jsonResponse({ errors: [{ message: "Issue not found", extensions: { code: "NOT_FOUND" } }] }) },
  { name: "multiple errors", category: "general", exit: 2,
    respond: () => jsonResponse({ errors: [
      { message: "Bad input", extensions: { field: "title" } },
      { message: "Expired", extensions: { code: "UNAUTHENTICATED" } },
    ] }) },
  { name: "missing payload", category: "general", exit: 1,
    respond: () => jsonResponse({ data: {} }) },
  { name: "false success with resource", category: "general", exit: 1,
    respond: () => jsonResponse({ data: {
      fileUpload: { success: false, uploadFile },
      projectCreate: { success: false, project },
      attachmentCreate: { success: false, attachment: { id: "att", title: "file", url: assetUrl } },
      issueBatchCreate: { success: false, issues: [] },
    } }) },
];

for (const command of ["file", "project"] as const) {
  describe(`${command} composite failures`, () => {
    let directory: string;
    let stdout: string[];
    let stderr: string[];

    beforeEach(async () => {
      directory = await mkdtemp(join(tmpdir(), "linearctl-workflow-"));
      await writeLinearConfigFile(join(directory, "config"), { defaultProfile: "work", profiles: { work: {} } });
      await writeCredentialsFile(join(directory, "credentials"), {
        profiles: { work: { profileName: "work", type: "api_key", apiKey: "lin_api_test" } },
      });
      await writeFile(join(directory, "file.txt"), "content");
      stdout = [];
      stderr = [];
      vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { stdout.push(String(chunk)); return true; });
      vi.spyOn(process.stderr, "write").mockImplementation((chunk) => { stderr.push(String(chunk)); return true; });
    });

    afterEach(async () => {
      vi.restoreAllMocks();
      await rm(directory, { recursive: true, force: true });
    });

    function invoke(fetchImpl: FetchLike, mode: "json" | "jsonEnvelope" | "human" = "jsonEnvelope") {
      const options = {
        configFile: join(directory, "config"), credentialsFile: join(directory, "credentials"),
        env: {}, json: mode === "json", jsonEnvelope: mode === "jsonEnvelope", noRetry: true, fetchImpl,
      };
      return command === "file"
        ? handleFileCommand(["upload", join(directory, "file.txt")], { ...options, issue: "TEAM-1" })
        : handleProjectCommand(["create-with-issues"], {
          ...options, name: "Existing", team: "00000000-0000-0000-0000-000000000001", issuesJson: '[{"title":"Task"}]',
        });
    }

    function firstResponse() {
      return jsonResponse({ data: command === "file"
        ? { fileUpload: { success: true, uploadFile } }
        : { projectCreate: { success: true, project } } });
    }

    function failingFetch(firstFails: boolean, respond: () => Response) {
      let calls = 0;
      return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        calls++;
        if (firstFails) return respond();
        if (calls === 1) return firstResponse();
        if (command === "file" && calls === 2) {
          for await (const _chunk of init?.body as unknown as Readable) { /* consume PUT */ }
          return new Response("", { status: 200 });
        }
        return respond();
      });
    }

    for (const firstFails of [true, false]) {
      it.each(failures)(`preserves $name when ${firstFails ? "first" : "second"} step fails`, async (failure) => {
        const fetchImpl = failingFetch(firstFails, failure.respond);
        expect(await invoke(fetchImpl)).toBe(failure.exit);
        const parsed = JSON.parse(stdout.join(""));
        expect(parsed.ok).toBe(false);
        expect(parsed.data).toBeNull();
        expect(parsed.meta.partial).toBe(!firstFails);
        expect(parsed.errors[0].category).toBe(failure.category);
        const details = parsed.errors[0].details;
        const workflow = details.workflow;
        expect(workflow.partialSuccess).toBe(!firstFails);
        expect(workflow.exitCode).toBe(failure.exit);
        expect(workflow.steps.first.status).toBe(firstFails ? "failed" : "success");
        expect(workflow.steps.second.status).toBe(firstFails ? "skipped" : "failed");
        expect(workflow.steps.second.name).toBe(command === "file" ? "create attachment" : "batch create issues");
        expect(fetchImpl).toHaveBeenCalledTimes(firstFails ? 1 : command === "file" ? 3 : 2);
        if (firstFails) {
          expect(workflow.completed).toEqual({});
          expect(details.recovery).toBeUndefined();
        } else if (command === "file") {
          expect(details).toMatchObject({ assetUrl, fileName: "file.txt", contentType: "text/plain", size: 7, attachment: null });
          expect(workflow.completed.first).toEqual({ assetUrl, fileName: "file.txt", contentType: "text/plain", size: 7 });
          expect(details.recovery).toContain("attachment create");
        } else {
          expect(details.project.id).toBe(project.id);
          expect(workflow.completed.first.id).toBe(project.id);
          expect(details.recovery).toContain("issue create");
        }
        if (failure.name === "GraphQL authentication") {
          expect(details.cause).toEqual({ path: ["mutation"], extensions: { code: "UNAUTHENTICATED" } });
        }
        if (failure.name === "structured transport exception") {
          expect(details.cause).toEqual({ requestId: "req-123" });
        }
        if (failure.name === "multiple errors") {
          expect(parsed.errors).toHaveLength(2);
          expect(workflow.errors).toHaveLength(2);
          expect(parsed.errors[1].category).toBe("authentication");
          expect(parsed.errors[1].details.cause).toEqual({ extensions: { code: "UNAUTHENTICATED" } });
        }
        expect(stdout.join("")).not.toContain("do-not-expose");
        expect(stdout.join("")).not.toContain(uploadFile.uploadUrl);
        expect(stderr).toEqual([]);
      });
    }

    it.each(["json", "human"] as const)("reports completed resources in %s mode", async (mode) => {
      const fetchImpl = failingFetch(false, () => { throw new Error("Connection lost"); });
      expect(await invoke(fetchImpl, mode)).toBe(1);
      if (mode === "json") {
        const parsed = JSON.parse(stdout.join(""));
        expect(parsed.ok).toBe(false);
        expect(parsed.errors[0].details.workflow.completed.first).toBeDefined();
        expect(stderr).toEqual([]);
      } else {
        expect(stdout).toEqual([]);
        expect(stderr.join("")).toContain(command === "file" ? assetUrl : project.id);
        expect(stderr.join("")).toContain(command === "file" ? "attachment create" : "issue create");
        expect(stderr.join("")).toContain("Connection lost");
      }
    });

    if (command === "file") {
      it.each([
        { name: "HTTP 403", respond: () => new Response("", { status: 403 }), exit: 2 },
        { name: "HTTP 429", respond: () => new Response("", { status: 429 }), exit: 3 },
        { name: "HTTP 500", respond: () => new Response("", { status: 500 }), exit: 1 },
        { name: "transport", respond: (): Response => { throw new Error("PUT failed"); }, exit: 1 },
      ])("does not mark the upload completed on PUT $name failure", async ({ respond, exit }) => {
        const fetchImpl = vi.fn(async () => fetchImpl.mock.calls.length === 1 ? firstResponse() : respond());
        expect(await invoke(fetchImpl)).toBe(exit);
        const parsed = JSON.parse(stdout.join(""));
        expect(parsed.errors[0].details.workflow.completed).toEqual({});
        expect(parsed.errors[0].details.workflow.steps.second.status).toBe("skipped");
        expect(parsed.errors[0].details.assetUrl).toBeUndefined();
        expect(fetchImpl).toHaveBeenCalledTimes(2);
      });
    }
  });
}
