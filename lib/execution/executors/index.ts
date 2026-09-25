/**
 * Same pattern as lib/workflows/definitions/index.ts — side-effect imports,
 * each file calling registerExecutor() at module load time. Import this
 * module, not the individual files, anywhere the executor registry needs
 * to be populated.
 */
import "./manual-trigger";
import "./set";
import "./transform";
import "./if";
import "./switch";
import "./merge";
import "./delay";
import "./http-request";
import "./code";
import "./triggers-not-implemented";
