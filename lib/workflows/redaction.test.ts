import { describe, it, expect } from "vitest";
import {
  redactWorkflowDocument,
  isSensitiveHttpHeader,
  SENSITIVE_HTTP_HEADERS,
  REDACTED,
} from "./redaction";

/**
 * The regression suite for the redaction defect: a name-based heuristic
 * was rewriting the workflow document itself, and the asynchronous path
 * executes that stored document. The split these tests pin down is:
 *
 *   runtime document  -> always intact, never "[REDACTED]"
 *   safe copy         -> may redact, but only HTTP headers of an
 *                        httpRequest node, never user-authored keys
 */

function setNode(values: Record<string, unknown>) {
  return { id: "s", type: "set", name: "Dados da reserva", position: { x: 200, y: 0 }, data: { values } };
}

function httpNode(headers: Record<string, string>) {
  return {
    id: "h",
    type: "httpRequest",
    name: "Confirmar reserva",
    position: { x: 400, y: 0 },
    data: { method: "POST", url: "https://api.exemplo/reservas", headers, query: {}, body: null },
  };
}

// Generic so `nodes` keeps its concrete inferred tuple type — these tests
// read deep into the document and shouldn't have to cast to do it.
function doc<T extends unknown[]>(...nodes: T) {
  return { schemaVersion: 1, nodes, edges: [] as unknown[], settings: { executionMode: "default" } };
}

// The part of a (possibly redacted) node the tests below read.
interface NodeView {
  data: { values: Record<string, unknown>; headers: Record<string, unknown> };
}

// Helper: the tests below reach into an `unknown` return value. A missing
// node fails loudly here instead of as a TypeError further down.
function nodeAt(result: unknown, index: number): NodeView {
  const node = (result as { nodes: NodeView[] }).nodes[index];
  if (node === undefined) throw new Error(`no node at index ${index}`);
  return node;
}

describe("redactWorkflowDocument", () => {
  describe("user-authored keys are never treated as secrets", () => {
    it("keeps a Set field named bookingKey intact", () => {
      const original = doc(setNode({ bookingKey: "LEN-2026-0417", passageiro: "Ana Souza" }));

      // the runtime document — what the planner and executors read
      expect(original.nodes[0].data.values.bookingKey).toBe("LEN-2026-0417");
      // and even the safe copy: a Set key is not a credential namespace
      expect(nodeAt(redactWorkflowDocument(original), 0).data.values.bookingKey).toBe("LEN-2026-0417");
    });

    it("keeps a Set field named tokenVoucher intact", () => {
      const original = doc(setNode({ tokenVoucher: "V-88213", diaria: 1250 }));

      expect(original.nodes[0].data.values.tokenVoucher).toBe("V-88213");
      expect(nodeAt(redactWorkflowDocument(original), 0).data.values.tokenVoucher).toBe("V-88213");
    });

    it("regression: the exact document from the audit survives untouched", () => {
      const values = {
        bookingKey: "LEN-2026-0417",
        passageiro: "Ana Souza",
        tokenVoucher: "V-88213",
        diaria: "1250",
      };
      const safe = redactWorkflowDocument(doc(setNode({ ...values })));

      expect(nodeAt(safe, 0).data.values).toEqual(values);
      expect(JSON.stringify(safe)).not.toContain(REDACTED);
    });

    it("does not redact header-looking names outside an httpRequest node", () => {
      // Same words, but this is a Set node: these are values a user typed.
      const safe = redactWorkflowDocument(doc(setNode({ Authorization: "valor do usuário", cookie: "receita" })));

      expect(nodeAt(safe, 0).data.values.Authorization).toBe("valor do usuário");
      expect(nodeAt(safe, 0).data.values.cookie).toBe("receita");
    });
  });

  describe("real credentials are redacted in the safe copy only", () => {
    const headers = {
      Authorization: "Bearer sk-live-9f3a2b",
      Cookie: "session=abc123",
      "X-Api-Key": "key_prod_7781",
      "Content-Type": "application/json",
      "X-Request-Id": "req-42",
    };

    it("redacts credential-bearing HTTP headers", () => {
      const safe = nodeAt(redactWorkflowDocument(doc(httpNode({ ...headers }))), 0);

      expect(safe.data.headers.Authorization).toBe(REDACTED);
      expect(safe.data.headers.Cookie).toBe(REDACTED);
      expect(safe.data.headers["X-Api-Key"]).toBe(REDACTED);
    });

    it("leaves non-credential headers readable", () => {
      const safe = nodeAt(redactWorkflowDocument(doc(httpNode({ ...headers }))), 0);

      expect(safe.data.headers["Content-Type"]).toBe("application/json");
      expect(safe.data.headers["X-Request-Id"]).toBe("req-42");
    });

    it("leaves the runtime document holding the real credential", () => {
      // The executor has to be able to actually send the header; redaction
      // belongs to the copy that leaves the server, not to the source.
      const original = doc(httpNode({ ...headers }));
      redactWorkflowDocument(original);

      expect(original.nodes[0].data.headers.Authorization).toBe("Bearer sk-live-9f3a2b");
    });

    it("matches header names case-insensitively, and only known ones", () => {
      expect(isSensitiveHttpHeader("AUTHORIZATION")).toBe(true);
      expect(isSensitiveHttpHeader("  Cookie  ")).toBe(true);
      expect(isSensitiveHttpHeader("bookingKey")).toBe(false);
      expect(isSensitiveHttpHeader("tokenVoucher")).toBe(false);
      expect(SENSITIVE_HTTP_HEADERS.every((h) => h === h.toLowerCase())).toBe(true);
    });
  });

  describe("the copy is a copy", () => {
    it("never mutates the input", () => {
      const original = doc(httpNode({ Authorization: "Bearer segredo" }), setNode({ bookingKey: "LEN-1" }));
      const before = structuredClone(original);

      redactWorkflowDocument(original);

      expect(original).toEqual(before);
    });

    it("shares no reference with the input", () => {
      const original = doc(httpNode({ Authorization: "Bearer segredo" }), setNode({ bookingKey: "LEN-1" }));
      // The safe copy keeps the input's shape (only header VALUES change), so
      // it is read with the input's own type.
      const safe = redactWorkflowDocument(original) as typeof original;

      expect(safe).not.toBe(original);
      expect(safe.nodes).not.toBe(original.nodes);
      expect(safe.nodes[0].data.headers).not.toBe(original.nodes[0].data.headers);

      safe.nodes[1].data.values.bookingKey = "MUTADO";
      expect(original.nodes[1].data.values.bookingKey).toBe("LEN-1");
    });
  });

  describe("read-path robustness", () => {
    // getExecutionById passes whatever jsonb held; a malformed row must not
    // break a read.
    it.each([null, undefined, 42, "texto", [], {}, { nodes: "nope" }])(
      "returns a value instead of throwing for %p",
      (input) => {
        expect(() => redactWorkflowDocument(input)).not.toThrow();
      }
    );

    it("skips httpRequest nodes whose data/headers are the wrong shape", () => {
      const weird = { nodes: [null, { type: "httpRequest" }, { type: "httpRequest", data: { headers: 7 } }] };

      expect(() => redactWorkflowDocument(weird)).not.toThrow();
    });
  });
});
