import { afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";

/**
 * O @testing-library/react só registra a limpeza automática dos renders
 * quando existe um `afterEach` GLOBAL. Este projeto não usa `globals: true`
 * — cada teste importa o que usa —, então essa limpeza nunca foi registrada:
 * o render de um teste continuava no documento e o teste seguinte encontrava
 * dois botões com o mesmo nome ("Found multiple elements with the role
 * button"). Registrar aqui resolve para todos os testes de componente de uma
 * vez, sem tocar em nenhum teste.
 *
 * O import é dinâmico e o hook sai cedo fora do DOM porque este arquivo roda
 * também nos testes de ambiente "node", onde não existe documento e o RTL não
 * tem o que limpar.
 */
afterEach(async () => {
  if (typeof document === "undefined") return;
  const { cleanup } = await import("@testing-library/react");
  cleanup();
});
