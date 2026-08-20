/**
 * Message type constants shared between agent and cloud relay.
 */
/**
 * Valid Claude states — single source of truth.
 * Referenced by screen scraper (tmux.js) and (via comment) cloud/public/app.js.
 */
export const CLAUDE_STATES = ['idle', 'working', 'permission', 'question', 'inputNeeded'];
export const HIGH_PRIORITY_STATES = ['permission', 'question', 'inputNeeded'];

export const MSG = {
  // Terminal I/O
  TERMINAL_ATTACH: 'terminal:attach',
  TERMINAL_ATTACHED: 'terminal:attached',
  TERMINAL_HISTORY: 'terminal:history',
  TERMINAL_INPUT: 'terminal:input',
  TERMINAL_PASTE_IMAGE: 'terminal:pasteImage',
  TERMINAL_OUTPUT: 'terminal:output',
  TERMINAL_RESIZE: 'terminal:resize',
  TERMINAL_SCROLL: 'terminal:scroll',
  TERMINAL_CLOSE: 'terminal:close',
  TERMINAL_CLOSED: 'terminal:closed',
  TERMINAL_DETACH: 'terminal:detach',
  TERMINAL_DETACHED: 'terminal:detached',
  TERMINAL_ERROR: 'terminal:error',
  TERMINAL_RESUME: 'terminal:resume',
  TERMINAL_RESUMED: 'terminal:resumed',

  // Browser panes. The hot path (frames, input) is its own message type rather
  // than REST-over-WS: frames arrive at up to 20/second per pane and every
  // request/response pair would allocate a pending entry for a reply nobody
  // reads. CRUD for browser panes still goes through /api/browser-panes.
  BROWSER_ATTACH: 'browser:attach',
  BROWSER_ATTACHED: 'browser:attached',
  BROWSER_DETACH: 'browser:detach',
  BROWSER_FRAME: 'browser:frame',
  BROWSER_TABS: 'browser:tabs',
  BROWSER_INPUT: 'browser:input',
  BROWSER_RESIZE: 'browser:resize',
  BROWSER_NAVIGATE: 'browser:navigate',
  BROWSER_TAB_NEW: 'browser:tab:new',
  BROWSER_TAB_CLOSE: 'browser:tab:close',
  BROWSER_TAB_SELECT: 'browser:tab:select',
  BROWSER_HISTORY: 'browser:history',
  BROWSER_ERROR: 'browser:error',

  // Pane lifecycle, broadcast to every canvas
  PANE_CREATED: 'pane:created',
  PANE_CLOSED: 'pane:closed',

  // Claude states
  CLAUDE_STATES: 'claude:states',

  // Metrics
  METRICS: 'metrics',

  // REST-over-WS
  REQUEST: 'request',
  RESPONSE: 'response',
  SCAN_PARTIAL: 'scan:partial',

  // Agent <-> Cloud
  AGENT_AUTH: 'agent:auth',
  AGENT_AUTH_OK: 'agent:auth:ok',
  AGENT_AUTH_FAIL: 'agent:auth:fail',
  AGENT_PING: 'agent:ping',
  AGENT_PONG: 'agent:pong',

  // Agent updates
  UPDATE_AVAILABLE: 'update:available',
  UPDATE_INSTALL: 'update:install',
  UPDATE_PROGRESS: 'update:progress',
};
