/** Maximum number of terminals per tab */
export const TERMINAL_COUNT = 4;

/** Delay in ms before running claude command after shell starts */
export const SHELL_INIT_DELAY_MS = 500;

/** Delay in ms before marking terminal as idle after output stops */
export const IDLE_TIMEOUT_MS = 2000;

/** Set of valid terminal IDs (0-3) */
export const VALID_TERMINAL_IDS = new Set([0, 1, 2, 3]);

/** Check if a terminal ID is valid */
export function isValidTerminalId(terminalId: number): boolean {
  return VALID_TERMINAL_IDS.has(terminalId);
}
