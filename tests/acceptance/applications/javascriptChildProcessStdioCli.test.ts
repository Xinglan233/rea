import { expect } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import { analyzeJavaScriptDirectory } from "../../support/cli/javascriptApplication.js";
import { writeFixtureFiles } from "../../support/javascriptApplicationFixture.js";

const cases = [
  ["duplicate", '{ stdio: "pipe", stdio: "inherit" }', "inherit"],
  ["explicit", '{ stdio: "inherit" }', "inherit"],
  ["spread-after", '{ stdio: "pipe", ...options }', "dynamic"],
  ["spread-before", '{ ...options, stdio: "inherit" }', "inherit"],
  ["computed-after", '{ stdio: "pipe", [key]: "inherit" }', "dynamic"],
  ["computed-before", '{ [key]: "pipe", stdio: "inherit" }', "inherit"],
  ["computed-literal", '{ stdio: "pipe", ["stdio"]: "inherit" }', "inherit"],
  ["unrelated", '{ stdio: "inherit", cwd: "/unused", [0]: "x" }', "inherit"],
  ["getter", '{ stdio: "pipe", get stdio() { return "inherit"; } }', "dynamic"],
  ["method", '{ stdio: "pipe", stdio() {} }', "dynamic"],
  ["value", "{ stdio: mode }", "dynamic"],
  ["options", "options", "dynamic"],
  ["expression", "chooseOptions()", "dynamic"],
  ["array", '{ stdio: ["ignore", "pipe", "pipe"] }', "array"],
  ["empty", "{}", "default"],
  ["env", '{ env: { MODE: "test" } }', "default"],
  ["null", "null", "default"],
  ["undefined", "undefined", "default"],
  ["void", "void 0", "default"],
  ["stdio-null", "{ stdio: null }", "default"],
  ["stdio-undefined", "{ stdio: undefined }", "default"],
  ["stdio-void", "{ stdio: void 0 }", "default"],
] as const;

cliTest.for(["CLI", "stdio MCP"] as const)(
  "preserves effective child-process stdio and uncertainty through %s",
  async (surface, { cli }) => {
    const root = await createTestTempDirectory("rea-child-stdio-");
    const expected = new Map<string, string>();
    const calls: string[] = [];
    for (const method of ["spawn", "exec", "execFile", "fork"] as const) {
      for (const [name, options, mode] of cases) {
        const command = `${method}-${name}`;
        expected.set(command, mode);
        calls.push(
          `${method}("${command}", ${method === "exec" ? "" : "[], "}${options});`,
        );
      }
      expected.set(`${method}-omitted`, "default");
      calls.push(`${method}("${method}-omitted");`);
      expected.set(`${method}-options-only`, "dynamic");
      calls.push(`${method}("${method}-options-only", options);`);
    }
    for (const call of [
      'exec("exec-callback", () => {});',
      'execFile("execFile-callback", [], () => {});',
      'execFile("execFile-options-callback", { stdio: "inherit" }, () => {});',
      'execFile("execFile-unknown-callback", options, () => {});',
      'spawn("spawn-options-final", { stdio: "pipe", stdio: "inherit" });',
    ]) {
      calls.push(call);
    }
    expected.set("exec-callback", "default");
    expected.set("execFile-callback", "default");
    expected.set("execFile-options-callback", "inherit");
    expected.set("execFile-unknown-callback", "dynamic");
    expected.set("spawn-options-final", "inherit");
    await writeFixtureFiles(root, {
      "entry.mjs": [
        'import { spawn, exec, execFile, fork } from "node:child_process";',
        'throw new Error("static fixture must never execute");',
        "export function run(options, key, mode) {",
        ...calls,
        "}",
        'export function shadowed(undefined) { spawn("shadowed-undefined", [], undefined); }',
      ].join("\n"),
    });
    expected.set("shadowed-undefined", "dynamic");
    const { semantic_graph: graph } = await analyzeJavaScriptDirectory(
      surface,
      cli,
      root,
    );
    const children = graph.nodes.filter(
      (node) => node.kind === "child-process",
    );
    expect(children).toHaveLength(expected.size);
    for (const child of children) {
      const command = String(child.properties.command);
      const mode = expected.get(command);
      expect(mode, command).toBeDefined();
      expect(child.properties.stdio_mode, command).toBe(mode);
      const stdio = graph.relations.filter(
        (relation) =>
          relation.source_node_id === child.node_id &&
          relation.relation === "connects-stdio",
      );
      expect(stdio, command).toHaveLength(1);
      expect(stdio[0]?.resolution, command).toBe(
        mode === "dynamic" ? "candidate" : "resolved",
      );
      const unknowns = graph.unknowns.filter(
        (unknown) =>
          unknown.family === "child-process" &&
          unknown.node_id === child.node_id &&
          unknown.relation_kinds.includes("connects-stdio"),
      );
      expect(unknowns.length, command).toBe(mode === "dynamic" ? 1 : 0);
      if (mode === "dynamic")
        expect(unknowns[0]).toMatchObject({ reason: "unknown-value" });
      expect(child.properties.environment_supplied, command).toBe(
        command.endsWith("-env"),
      );
      if (cases.some(([name]) => command === `spawn-${name}`))
        expect(child.properties.argv_count, command).toBe(0);
    }
    expect(
      graph.coverage.families.find(({ family }) => family === "child-process"),
    ).toMatchObject({ status: "partial" });
  },
);
