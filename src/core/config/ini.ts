export type IniSection = Record<string, string>;
export type IniDocument = Record<string, IniSection>;

const RESERVED_OBJECT_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export class IniParseError extends Error {
  constructor(
    message: string,
    readonly lineNumber: number
  ) {
    super(`INI parse error on line ${lineNumber}: ${message}`);
    this.name = "IniParseError";
  }
}

export function parseIni(input: string): IniDocument {
  const document = Object.create(null) as IniDocument;
  let currentSectionName: string | undefined;

  for (const [index, rawLine] of input.split(/\r?\n/).entries()) {
    const lineNumber = index + 1;
    const line = rawLine.trim();

    if (line === "" || line.startsWith("#") || line.startsWith(";")) {
      continue;
    }

    const sectionMatch = /^\[([^\]]+)\]$/.exec(line);
    if (sectionMatch) {
      const sectionName = sectionMatch[1]?.trim();
      if (!sectionName) {
        throw new IniParseError("section name is required", lineNumber);
      }

      if (RESERVED_OBJECT_KEYS.has(sectionName)) {
        throw new IniParseError("invalid section name", lineNumber);
      }

      currentSectionName = sectionName;
      document[currentSectionName] ??= Object.create(null) as IniSection;
      continue;
    }

    const separatorIndex = line.indexOf("=");
    if (separatorIndex === -1) {
      throw new IniParseError("expected key = value", lineNumber);
    }

    if (currentSectionName === undefined) {
      throw new IniParseError("key-value pair must be inside a section", lineNumber);
    }

    const section = document[currentSectionName];
    if (section === undefined) {
      throw new IniParseError("active section is missing", lineNumber);
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();

    if (!key) {
      throw new IniParseError("key is required", lineNumber);
    }

    if (RESERVED_OBJECT_KEYS.has(key)) {
      throw new IniParseError("invalid key", lineNumber);
    }

    section[key] = value;
  }

  return document;
}

export function stringifyIni(document: IniDocument): string {
  const lines: string[] = [];

  for (const [sectionName, section] of Object.entries(document)) {
    if (lines.length > 0) {
      lines.push("");
    }

    lines.push(`[${sectionName}]`);

    for (const [key, value] of Object.entries(section)) {
      lines.push(`${key} = ${value}`);
    }
  }

  return `${lines.join("\n")}\n`;
}
