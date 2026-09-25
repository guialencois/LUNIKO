/**
 * Side-effect import: each of these modules calls registerNode() at module
 * load time. Import this module (not the individual files) anywhere you
 * need the registry populated — the schema validator, the node library
 * sidebar, and API routes all do this exactly once per process.
 *
 * To add a new node type (see docs/adding-nodes.md):
 * 1. Create lib/workflows/definitions/<type>.ts following this pattern.
 * 2. Add its import below.
 * That's it — no other file needs to change to make the type known to
 * validation, the registry, or the node library.
 */
import "./manual-trigger";
import "./webhook-trigger";
import "./schedule-trigger";
import "./http-request";
import "./set";
import "./if";
import "./switch";
import "./transform";
import "./merge";
import "./delay";
import "./code";
