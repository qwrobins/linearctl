export async function readAllStdin(stdin: NodeJS.ReadableStream): Promise<string> {
  stdin.setEncoding("utf8");
  let contents = "";

  for await (const chunk of stdin) {
    contents += chunk;
  }

  return contents;
}

export function isTtyInput(stdin: NodeJS.ReadableStream): boolean {
  return "isTTY" in stdin && stdin.isTTY === true;
}
