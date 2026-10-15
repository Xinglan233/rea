import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect } from "vitest";

import { toolContract } from "../../../src/contracts/toolContracts.js";
import { javascriptApplicationAnalysisResultSchema } from "../../../src/domain/javascript/javascriptApplicationAnalysis.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest(
  "keeps this emitter identities uncertain through CLI and stdio MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-this-emitter-");
    const source = `
      import { EventEmitter } from "node:events";
      class Producer extends EventEmitter {
        run() { this.on("ready", () => {}); }
      }
      class Unrelated extends EventEmitter {
        run() { this.emit("ready"); }
      }
      class Shared {
        register() { this.on("ready", handler); }
        dispatch() { this.emit("ready"); }
        repeated() { this.on("ready", handler); this.emit("ready"); }
        static register() { this.on("ready", handler); }
        static dispatch() { this.emit("ready"); }
        arrows() {
          const register = () => this.on("ready", handler);
          const dispatch = () => this.emit("ready");
          function nested() { this.emit("ready"); }
        }
        field = () => { this.on("ready", handler); this.emit("ready"); };
      }
      function register() { this.on("ready", handler); }
      function dispatch() { this.emit("ready"); }
      const object = {
        register() { this.on("ready", handler); },
        dispatch() { this.emit("ready"); }
      };
      this.on("ready", handler);
      const arrow = () => this.emit("ready");
      const stable = new EventEmitter();
      stable.on("ready", handler);
      stable.emit("ready");
      stable.off("ready", handler);
    `;
    await writeFile(join(root, "main.mjs"), source);
    const cliResponse = await cli.run({
      arguments: [
        "analyze-javascript-application",
        root,
        "--artifact-format",
        "directory",
        "--json",
      ],
    });
    expect(cliResponse.exitCode, cliResponse.stdout + cliResponse.stderr).toBe(
      0,
    );
    const contract = toolContract("analyze_javascript_application");
    const cliEvidence = contract.outputSchema.parse(cliResponse.json);
    const client = new Client({ name: "this-emitter-e2e", version: "1" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve("scripts/rea.mjs"), "mcp"],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "" },
      stderr: "pipe",
    });
    transport.stderr?.on("data", () => undefined);
    try {
      await client.connect(transport);
      const response = await client.callTool({
        name: "analyze_javascript_application",
        arguments: { input_path: root, format: "directory" },
      });
      expect(response.isError).not.toBe(true);
      const evidence = contract.outputSchema.parse(response.structuredContent);
      expect(evidence.evidence_id).toBe(cliEvidence.evidence_id);
      const graph = javascriptApplicationAnalysisResultSchema.parse(
        evidence.normalized_result,
      ).semantic_graph;
      const events = graph.nodes.filter((node) => node.kind === "event");
      const stable = events.filter((node) =>
        String(node.properties.emitter_key).startsWith("binding:"),
      );
      expect(stable).toHaveLength(1);
      const receivers = events.filter((node) => !stable.includes(node));
      const receiverCount = source.match(/this\.(?:on|emit)\(/gu)?.length;
      expect(receivers).toHaveLength(receiverCount ?? 0);
      expect(
        new Set(receivers.map((node) => node.properties.emitter_key)).size,
      ).toBe(receivers.length);
      const receiverIds = new Set(receivers.map((node) => node.node_id));
      const eventRelations = graph.relations.filter(({ relation }) =>
        [
          "registers-listener",
          "dispatches-candidate",
          "removes-listener",
        ].includes(relation),
      );
      const uncertain = eventRelations.filter(
        ({ source_node_id, target_node_id }) =>
          receiverIds.has(source_node_id) || receiverIds.has(target_node_id),
      );
      expect(uncertain).toHaveLength(receiverCount ?? 0);
      expect(
        uncertain.every(({ resolution }) => resolution === "candidate"),
      ).toBe(true);
      for (const receiver of receivers) {
        expect(receiver.properties.event_name).toBe("ready");
        expect(graph.unknowns).toContainEqual(
          expect.objectContaining({
            node_id: receiver.node_id,
            family: "event",
            reason: "ambiguous-target",
          }),
        );
      }
      const stableRelations = eventRelations.filter(
        ({ source_node_id, target_node_id }) =>
          source_node_id === stable[0]?.node_id ||
          target_node_id === stable[0]?.node_id,
      );
      expect(stableRelations).toHaveLength(3);
      expect(new Set(stableRelations.map(({ relation }) => relation))).toEqual(
        new Set([
          "registers-listener",
          "dispatches-candidate",
          "removes-listener",
        ]),
      );
      expect(
        stableRelations.every(({ resolution }) => resolution === "resolved"),
      ).toBe(true);
      expect(graph.limitations).toContain(
        "The semantic graph contains static syntax observations and conservative relationship candidates; it does not claim runtime execution.",
      );
      await client.ping();
    } finally {
      await client.close();
      await transport.close();
    }
  },
  60_000,
);
