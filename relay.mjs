// cluadex relay. Starts the installed ChatGPT app's own computer-use MCP server and passes MCP
// through unchanged, adding only what a host other than Codex lacks:
//   1. a per-app approval dialog that only the person at the Mac can answer,
//   2. turn-end cleanup, signalled by this plugin's Stop / UserPromptSubmit hooks,
//   3. a guard so the app hosting this agent can never be approved.
// It contains no computer-use logic and no OpenAI files. Run it with the app's bundled Node.
import assert from 'node:assert/strict';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const OPENAI_TEAM_ID = '2DC432GLL2';
const PUBLIC_TOOLS = new Set(['js', 'js_reset']); // turn_ended and js_add_node_module_dir stay host-only
const TURN_META = 'x-codex-turn-metadata';
const STATE_DIR = join(homedir(), 'Library/Caches/cluadex');
const APPROVAL_SECONDS = Number(process.env.CLUADEX_APPROVAL_SECONDS) || 120; // unanswered prompts deny

function log(text) {
  process.stderr.write(`cluadex: ${text}\n`);
  if (process.env.CLUADEX_LOG) appendFileSync(process.env.CLUADEX_LOG, `${new Date().toISOString()} ${text}\n`);
}

// ---- the installed app --------------------------------------------------------------------

/** This file normally runs under the app's own Node, so the app is wherever that Node lives. */
function appPaths(env = process.env, execPath = process.execPath) {
  const marker = '/Contents/Resources/cua_node/bin/node';
  const app = env.CLUADEX_APP || (execPath.endsWith(marker) ? execPath.slice(0, -marker.length) : '/Applications/ChatGPT.app');
  const resources = join(app, 'Contents/Resources');
  const runtime = join(resources, 'cua_node');
  const modules = join(runtime, 'lib/node_modules');
  return {
    app, resources, runtime, modules,
    node: join(runtime, 'bin/node'),
    nodeRepl: join(runtime, 'bin/node_repl'),
    launcher: join(modules, '@oai/cua-repl/bin/cua-repl.mjs'),
    helper: join(modules, '@oai/sky/Codex Computer Use.app'),
  };
}

/** The helper holds Accessibility and Screen Recording; start nothing that OpenAI did not sign. */
function assertSignedByOpenAI(path) {
  const verify = spawnSync('/usr/bin/codesign', ['--verify', '--strict', path]);
  const info = spawnSync('/usr/bin/codesign', ['-dv', path], { encoding: 'utf8' });
  if (verify.status !== 0 || !String(info.stderr).split('\n').includes(`TeamIdentifier=${OPENAI_TEAM_ID}`)) {
    throw new Error(`not a valid OpenAI-signed file: ${path}`);
  }
}

function plistValue(bundle, key) {
  const out = spawnSync('/usr/bin/defaults', ['read', join(bundle, 'Contents/Info'), key], { encoding: 'utf8' });
  return out.status === 0 ? out.stdout.trim() : undefined;
}

/** The environment Codex itself gives this server; values observed from the app's own launcher. */
function upstreamEnv(p, session) {
  const codexHome = process.env.CODEX_HOME || join(homedir(), '.codex');
  return {
    ...process.env,
    PATH: `${join(p.runtime, 'bin')}:${process.env.PATH || '/usr/bin:/bin'}`,
    CODEX_HOME: codexHome,
    CUA_REPL_NODE_REPL_PATH: p.nodeRepl,
    NODE_REPL_NODE_PATH: p.node,
    NODE_REPL_NODE_MODULE_DIRS: p.modules,
    NODE_REPL_TRUSTED_CODE_PATHS: [codexHome, p.modules, join(p.resources, 'plugins')].join(':'),
    CUA_REPL_ENABLED_SURFACES: 'computer',
    CUA_REPL_BROWSER_ENV: 'codex-app',
    CODEX_CLI_PATH: join(p.resources, 'codex-cli/bin/codex'),
    SKY_CUA_SERVICE_PATH: p.helper,
    NODE_REPL_NATIVE_PIPE_CONNECT_TIMEOUT_MS: '1000',
    BROWSER_USE_AVAILABLE_BACKENDS: 'chrome',
    BROWSER_USE_TINYSKY_ENABLED: '1',
    BROWSER_USE_CODEX_APP_BUILD_FLAVOR: 'prod',
    BROWSER_USE_CODEX_APP_VERSION: plistValue(p.app, 'CFBundleShortVersionString') ?? '',
    NODE_REPL_DISABLE_ANALYTICS: '1',
    BROWSER_USE_DISABLE_AMBIENT_NETWORK: '1',
    NODE_REPL_REQUEST_META: JSON.stringify({ [TURN_META]: { session_id: session, turn_id: `${session}-turn-1` } }),
  };
}

// ---- host-app guard -----------------------------------------------------------------------

// Claude Code asks its permission questions inside the app that hosts it. If computer use were
// allowed to drive that app, the agent could answer those questions itself, so requests for it
// are refused without asking. (Idea from LCU's host guard; see README.)
const KNOWN_AGENT_HOSTS = [
  ['com.anthropic.claudefordesktop', 'Claude'],
  ['com.anthropic.claude-code', 'Claude Code'],
  ['com.apple.Terminal', 'Terminal'],
  ['com.googlecode.iterm2', 'iTerm2', 'iTerm'],
  ['com.mitchellh.ghostty', 'Ghostty'],
  ['dev.warp.Warp-Stable', 'Warp'],
  ['com.github.wez.wezterm', 'WezTerm'],
  ['org.alacritty', 'Alacritty'],
  ['net.kovidgoyal.kitty', 'kitty'],
];

const norm = value => (typeof value === 'string' ? value.trim().toLowerCase() : '');

/** Every spelling under which a host app could be requested: bundle id, names, bundle path. */
function hostKeys(detected, own = []) {
  const keys = new Set([...KNOWN_AGENT_HOSTS.flat(), ...own].map(norm));
  for (const host of detected) {
    for (const key of [host.id, host.path, ...host.names]) if (norm(key)) keys.add(norm(key));
  }
  return keys;
}

// ponytail: matches by spelling, not by resolving the request to a bundle the way the runtime does;
// an alias the runtime accepts but this list lacks would pass. Resolve via LaunchServices if that happens.
function isListed(requested, keys) {
  return requested.some(value => {
    const key = norm(value);
    return key !== '' && (keys.has(key) || keys.has(norm(basename(key).replace(/\.app$/, ''))));
  });
}

/** The .app bundles this process runs inside: the terminal, IDE or desktop app hosting the agent. */
function detectHostApps() {
  const hosts = [];
  let pid = process.ppid;
  for (let depth = 0; depth < 12 && pid > 1; depth += 1) {
    const out = spawnSync('/bin/ps', ['-o', 'ppid=', '-o', 'comm=', '-p', String(pid)], { encoding: 'utf8' });
    const match = /^\s*(\d+)\s+(.+)$/.exec(String(out.stdout).trim());
    if (!match) break;
    const end = match[2].indexOf('.app/');
    if (end >= 0) {
      const path = match[2].slice(0, end + 4);
      hosts.push({
        path,
        id: plistValue(path, 'CFBundleIdentifier'),
        names: [basename(path, '.app'), plistValue(path, 'CFBundleName'), plistValue(path, 'CFBundleDisplayName')],
      });
    }
    pid = Number(match[1]);
  }
  return hosts;
}

// ---- approval -----------------------------------------------------------------------------

const APPROVE_UI = fileURLToPath(new URL('./bin/approve-ui', import.meta.url));
const LABELS = { once: 'Allow once', session: 'Allow this conversation', always: 'Always allow' };

// Used only when bin/approve-ui has not been built or cannot run (macOS older than 26).
const FALLBACK_DIALOG = `on run argv
	set msg to item 1 of argv
	set opts to rest of argv
	activate
	set picked to choose from list opts with title "Computer use approval" with prompt msg OK button name "Allow" cancel button name "Deny"
	if picked is false then return "deny"
	return item 1 of picked
end run`;

/**
 * The scopes OpenAI's runtime offers, with its meaning: each one covers only the app being
 * asked about. `session` lasts for this conversation, `always` is remembered permanently.
 * Anything the runtime does not call low risk is shown as high risk.
 */
function approvalOptions(meta) {
  const persist = Array.isArray(meta.persist) ? meta.persist : [];
  const options = [persist.includes('session') ? 'session' : 'once'];
  if (persist.includes('always')) options.push('always');
  return { options, highRisk: meta.riskLevel !== 'low' };
}

/** Turn the pressed choice into the runtime's answer. A choice that was not offered is a denial. */
function approvalResult(choice, options) {
  if (!options.includes(choice)) return { action: 'decline' };
  if (choice === 'once') return { action: 'accept', content: {} };
  return { action: 'accept', content: {}, _meta: { persist: choice } };
}

const riskText = meta => meta.warningSubtitle || meta.subtitle ||
  'The runtime marks this app as high risk. What it shows can carry instructions aimed at the agent.';

const isAppApproval = params =>
  params?._meta?.connector_id === 'computer-use' && params._meta.codex_approval_kind === 'mcp_tool_call';

/** A prompt outside the host app: it works in every host, and the model can neither see nor press it. */
function askPerson({ app, shown, risk, options }) {
  const name = shown ?? app ?? 'this app';
  const fallback = resolve => {
    const labels = options.map(key => LABELS[key]);
    const text = `Allow computer use to control ${name}?${risk ? `\n\nHigh risk: ${risk}` : ''}`;
    execFile('/usr/bin/osascript', ['-e', FALLBACK_DIALOG, text, ...labels], { timeout: APPROVAL_SECONDS * 1000 },
      (error, stdout) => resolve(error ? 'deny' : Object.keys(LABELS).find(key => LABELS[key] === stdout.trim()) ?? 'deny'));
  };
  return new Promise(resolve => {
    if (process.env.CLUADEX_PLAIN_PROMPT || !existsSync(APPROVE_UI)) return fallback(resolve);
    // Some installs drop the executable bit. Restore it; if that fails, the exec below fails and the plain prompt asks.
    try { chmodSync(APPROVE_UI, 0o755); } catch { /* handled by the fallback */ }
    const args = ['--app', app ?? '', '--name', name, '--options', options.join(','), '--timeout', String(APPROVAL_SECONDS)];
    if (risk) args.push('--risk', risk);
    execFile(APPROVE_UI, args, { timeout: (APPROVAL_SECONDS + 10) * 1000 }, (error, stdout) => {
      if (error && !error.killed) return fallback(resolve);   // the panel could not run; ask the plain way
      resolve(error ? 'deny' : stdout.trim());
    });
  });
}

// ---- enumerated tools ---------------------------------------------------------------------

// The runtime's own surface is one tool that runs JavaScript. These wrap its computer-use
// functions as ordinary tools, so a host can list them, check their arguments and set
// permissions per action. Each call becomes one `js` call upstream; nothing is reimplemented.
const APP = { type: 'string', description: 'App name, bundle identifier, or path to the .app.' };
const INDEX = { type: 'integer', description: 'Element index from the most recent get_app_state text for this app.' };
const X = { type: 'number', description: 'Horizontal pixel position in the app screenshot.' };
const Y = { type: 'number', description: 'Vertical pixel position in the app screenshot.' };
const AFTER = ' Returns the app state after the action.';

const TOOLS = {
  list_apps: { readOnly: true, required: [], properties: {},
    description: 'List the apps on this Mac that computer use can work with, running or not.' },
  get_app_state: { readOnly: true, required: ['app'],
    properties: { app: APP,
      full: { type: 'boolean', description: 'Return the whole accessibility tree instead of the changes since the last call.' },
      screenshot: { type: 'boolean', description: 'Also return a screenshot of the window. Use when the text is not enough.' } },
    description: 'Read an app\'s key window as accessibility text with numbered elements, starting the app if needed. Call it before acting on an app and whenever the UI may have changed.' },
  click: { required: ['app'],
    properties: { app: APP, element_index: INDEX, x: X, y: Y,
      mouse_button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Defaults to left.' },
      click_count: { type: 'integer', minimum: 1, maximum: 3, description: 'Defaults to 1; 2 is a double click.' } },
    description: 'Click an element by index, or a point by x and y. Prefer the index.' + AFTER },
  type_text: { required: ['app', 'text'],
    properties: { app: APP, text: { type: 'string', description: 'Text to type. A newline presses Return, which may submit a form.' } },
    description: 'Type literal text into the focused field of an app.' + AFTER },
  press_key: { required: ['app', 'key'],
    properties: { app: APP, key: { type: 'string', description: 'xdotool-style key or combination, such as "Return", "Tab", "Up", "super+c".' } },
    description: 'Press a key or key combination in an app. It cannot trigger global shortcuts.' + AFTER },
  set_value: { required: ['app', 'element_index', 'value'],
    properties: { app: APP, element_index: INDEX, value: { type: 'string', description: 'The new value.' } },
    description: 'Set the value of a settable element, such as a text field or slider.' + AFTER },
  select_text: { required: ['app', 'element_index', 'text'],
    properties: { app: APP, element_index: INDEX,
      text: { type: 'string', description: 'The text to select, or to place the cursor next to.' },
      prefix: { type: 'string', description: 'Text right before it, to pick one of several matches.' },
      suffix: { type: 'string', description: 'Text right after it, to pick one of several matches.' },
      selection_type: { type: 'string', enum: ['text', 'cursor_before', 'cursor_after'], description: 'Defaults to text.' } },
    description: 'Select text inside a text element, or place the cursor before or after it.' + AFTER },
  paste: { required: ['app', 'text', 'format'],
    properties: { app: APP, text: { type: 'string', description: 'What to paste.' },
      format: { type: 'string', enum: ['text', 'md', 'html'], description: 'How the text is interpreted.' } },
    description: 'Paste text into an app, keeping the clipboard as it was. Good for formatted or multi-line text.' + AFTER },
  scroll: { required: ['app', 'direction'],
    properties: { app: APP, element_index: INDEX, x: X, y: Y,
      direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
      pages: { type: 'number', description: 'How far, in pages. Defaults to 1.' } },
    description: 'Scroll an element, or the view at a point, by pages.' + AFTER },
  drag: { required: ['app', 'from_x', 'from_y', 'to_x', 'to_y'],
    properties: { app: APP, from_x: X, from_y: Y, to_x: X, to_y: Y },
    description: 'Press at one point of the app screenshot, move to another and release.' + AFTER },
  perform_secondary_action: { required: ['app', 'element_index', 'action'],
    properties: { app: APP, element_index: INDEX,
      action: { type: 'string', description: 'An action the element lists under Secondary Actions, spelled exactly as shown.' } },
    description: 'Run one of an element\'s secondary accessibility actions, such as Raise, Show Menu or Increment.' + AFTER },
};

function toolDescriptors() {
  return Object.entries(TOOLS).map(([name, spec]) => ({
    name,
    description: spec.description,
    inputSchema: { type: 'object', properties: spec.properties, required: spec.required, additionalProperties: false },
    annotations: { readOnlyHint: Boolean(spec.readOnly) },
  }));
}

/** The names of required arguments that are absent, so a bad call fails here with a clear message. */
function missingArguments(name, args) {
  return TOOLS[name].required.filter(key => args?.[key] === undefined || args[key] === null);
}

/** The JavaScript one tool call becomes. Arguments travel as a JSON literal, never as code. */
function toolCode(name, args) {
  const known = Object.fromEntries(Object.entries(args ?? {}).filter(([key]) => key in TOOLS[name].properties));
  const open = `const sky = globalThis.__cluadexSky ??= (await import("@oai/sky")).sky; const a = ${JSON.stringify(known)};`;
  let body;
  if (name === 'list_apps') {
    body = 'nodeRepl.write(JSON.stringify(await sky.list_apps(), null, 1));';
  } else if (name === 'get_app_state') {
    body = 'const s = await sky.get_app_state({ app: a.app, disableDiff: a.full === true }); nodeRepl.write(s.text);' +
      ' if (a.screenshot === true && s.screenshot) { const fs = await import("node:fs/promises"); const { fileURLToPath } = await import("node:url");' +
      ' const bytes = await fs.readFile(fileURLToPath(s.screenshot.url));' +
      ' await nodeRepl.emitImage({ bytes, mimeType: bytes[0] === 0x89 ? "image/png" : "image/jpeg" }); }';
  } else {
    body = `await sky.${name}(a); nodeRepl.write((await sky.get_app_state({ app: a.app })).text);`;
  }
  return `await (async () => { ${open} ${body} })();`;
}

// ---- relay --------------------------------------------------------------------------------

function filterTools(tools) {
  return tools.filter(tool => PUBLIC_TOOLS.has(tool.name));
}

function main() {
  const p = appPaths();
  if (!existsSync(p.launcher) || !existsSync(p.helper)) {
    throw new Error(`ChatGPT desktop app with computer use not found at ${p.app} (set CLUADEX_APP to its path)`);
  }
  for (const file of [p.node, p.nodeRepl, p.helper]) assertSignedByOpenAI(file);

  const session = `cluadex-${randomUUID()}`;
  let turn = 1;
  let turnUsed = false;
  let ownId = 0;
  let hostElicits = false;
  let hosts;
  let prompts = Promise.resolve();
  const listIds = new Set();
  const ownIds = new Set();
  const turnId = () => `${session}-turn-${turn}`;

  const upstream = spawn(p.node, [p.launcher], { env: upstreamEnv(p, session), stdio: ['pipe', 'pipe', 'inherit'] });
  const toHost = message => process.stdout.write(`${JSON.stringify(message)}\n`);
  const toUpstream = message => upstream.stdin.write(`${JSON.stringify(message)}\n`);
  const parse = line => { try { return JSON.parse(line); } catch { return undefined; } };

  function endTurn(event) {
    if (!turnUsed) return;
    const id = `cluadex-${ownId += 1}`;
    ownIds.add(id);
    toUpstream({ jsonrpc: '2.0', id, method: 'tools/call',
      params: { name: 'turn_ended', arguments: { session_id: session, turn_id: turnId(), hook_event_name: event } } });
    log(`turn ${turn} ended (${event})`);
    turn += 1;
    turnUsed = false;
  }

  async function decide(params) {
    const meta = params._meta ?? {};
    const app = meta.tool_params?.app;
    const shown = meta.tool_params_display?.find(entry => entry.name === 'app')?.value;
    const requested = [app, shown];
    const label = shown ?? app ?? 'unknown app';
    // The prompt itself counts as a host: an agent that could drive it could approve anything.
    hosts ??= hostKeys(detectHostApps(), ['approve-ui', APPROVE_UI, 'osascript', '/usr/bin/osascript']);
    if (isListed(requested, hosts)) {
      log(`declined ${label}: it hosts this agent or its approval prompt`);
      return { action: 'decline' };
    }
    if (process.env.CLUADEX_APPROVAL === 'deny') return { action: 'decline' }; // unattended runs; there is no allow override
    const offer = approvalOptions(meta);
    const choice = await (prompts = prompts.then(() => askPerson({
      app, shown, risk: offer.highRisk ? riskText(meta) : '', options: offer.options })));
    log(`${label}: ${choice}${offer.highRisk ? ' (high risk)' : ''}`);
    return approvalResult(choice, offer.options);
  }

  createInterface({ input: process.stdin }).on('line', line => {
    const message = parse(line);
    if (!message) return;
    if (message.method === 'initialize') {
      hostElicits = Boolean(message.params?.capabilities?.elicitation);
      message.params = { ...message.params, capabilities: { ...message.params?.capabilities, elicitation: {} } };
    }
    if (message.method === 'tools/list' && message.id !== undefined) listIds.add(message.id);
    if (message.method === 'tools/call') {
      const name = message.params?.name;
      if (Object.hasOwn(TOOLS, name)) {
        const missing = missingArguments(name, message.params.arguments);
        if (missing.length) {
          toHost({ jsonrpc: '2.0', id: message.id, result: { isError: true, content: [{ type: 'text', text: `${name} needs ${missing.join(', ')}.` }] } });
          return;
        }
        message.params = { ...message.params, name: 'js', arguments: { code: toolCode(name, message.params.arguments), title: name } };
      } else if (!PUBLIC_TOOLS.has(name)) {
        toHost({ jsonrpc: '2.0', id: message.id, result: { isError: true, content: [{ type: 'text', text: `${name} is not available.` }] } });
        return;
      }
      turnUsed = true;
      message.params._meta = { ...message.params._meta, [TURN_META]: { session_id: session, turn_id: turnId() } };
    }
    toUpstream(message);
  }).on('close', () => upstream.stdin.end());

  createInterface({ input: upstream.stdout }).on('line', line => {
    const message = parse(line);
    if (!message) return;
    if (message.id !== undefined && ownIds.delete(message.id)) {
      if (message.error || message.result?.isError) log(`turn cleanup failed: ${JSON.stringify(message.error ?? message.result).slice(0, 300)}`);
      return;
    }
    if (message.id !== undefined && listIds.delete(message.id) && Array.isArray(message.result?.tools)) {
      message.result.tools = [...toolDescriptors(), ...filterTools(message.result.tools)];
    }
    if (message.method === 'elicitation/create' && isAppApproval(message.params)) {
      decide(message.params).then(result => toUpstream({ jsonrpc: '2.0', id: message.id, result }));
      return;
    }
    if (message.method === 'elicitation/create' && !hostElicits) {
      toUpstream({ jsonrpc: '2.0', id: message.id, result: { action: 'cancel' } });
      return;
    }
    toHost(message);
  });

  // The hooks reach this process through a socket named after the Claude Code process that started it.
  // It accepts one thing only: "the turn is over". Approvals never travel this way.
  const socketPath = join(STATE_DIR, `${process.ppid}.sock`);
  const cleanup = () => rmSync(socketPath, { force: true });
  try {
    mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
    cleanup();
    createServer(connection => {
      connection.on('data', data => endTurn(String(data).trim() === 'Interrupt' ? 'Interrupt' : 'Stop'));
      connection.on('error', () => {});
      connection.end();
    }).on('error', error => log(`turn cleanup is off: ${error.message}`)).listen(socketPath);
  } catch (error) {
    log(`turn cleanup is off: ${error.message}`);
  }

  upstream.on('exit', code => { cleanup(); process.exit(code ?? 1); });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => { upstream.kill(); cleanup(); process.exit(0); });
  }
}

// ---- checks -------------------------------------------------------------------------------

/** `--selftest`: the logic that decides who gets approved, with no app and no desktop needed. */
function selftest() {
  assert.deepEqual(filterTools([{ name: 'js' }, { name: 'turn_ended' }, { name: 'js_reset' }, { name: 'js_add_node_module_dir' }])
    .map(tool => tool.name), ['js', 'js_reset']);
  assert.deepEqual(approvalOptions({ riskLevel: 'low', persist: ['session', 'always'] }), { options: ['session', 'always'], highRisk: false });
  assert.deepEqual(approvalOptions({ riskLevel: 'low', persist: ['session'] }).options, ['session']);
  assert.deepEqual(approvalOptions({ riskLevel: 'low' }).options, ['once']);
  assert.equal(approvalOptions({ riskLevel: 'high', persist: ['session'] }).highRisk, true);
  assert.equal(approvalOptions({ persist: ['session'] }).highRisk, true, 'a missing risk level is treated as high');
  assert.deepEqual(approvalResult('session', ['session', 'always']), { action: 'accept', content: {}, _meta: { persist: 'session' } });
  assert.deepEqual(approvalResult('always', ['session', 'always']), { action: 'accept', content: {}, _meta: { persist: 'always' } });
  assert.deepEqual(approvalResult('once', ['once']), { action: 'accept', content: {} });
  assert.deepEqual(approvalResult('always', ['session']), { action: 'decline' }, 'a choice that was not offered');
  for (const other of ['deny', 'timeout', '', 'conversation']) assert.deepEqual(approvalResult(other, ['session', 'always']), { action: 'decline' });
  const keys = hostKeys([{ id: 'com.example.orca', path: '/Applications/Orca.app', names: ['Orca', undefined] }], ['approve-ui', '/x/bin/approve-ui', 'osascript']);
  assert(isListed(['com.anthropic.claudefordesktop'], keys));
  assert(isListed([undefined, 'Claude'], keys));
  assert(isListed(['/Applications/Orca.app'], keys));
  assert(isListed(['/Users/me/Applications/orca.app', undefined], keys));
  assert(isListed(['COM.EXAMPLE.ORCA'], keys));
  assert(isListed(['approve-ui'], keys) && isListed(['/other/place/approve-ui'], keys) && isListed([undefined, 'osascript'], keys));
  assert(!isListed(['com.apple.calculator', 'Calculator'], keys));
  assert(!isListed([undefined, undefined], keys));
  assert(isAppApproval({ _meta: { connector_id: 'computer-use', codex_approval_kind: 'mcp_tool_call' } }));
  assert(!isAppApproval({ _meta: { connector_id: 'chrome' } }));
  assert.equal(riskText({ warningSubtitle: 'Sees passwords.' }), 'Sees passwords.');
  assert.deepEqual(toolDescriptors().map(tool => tool.name), ['list_apps', 'get_app_state', 'click', 'type_text', 'press_key',
    'set_value', 'select_text', 'paste', 'scroll', 'drag', 'perform_secondary_action']);
  for (const tool of toolDescriptors()) {
    assert(tool.inputSchema.required.every(key => key in tool.inputSchema.properties), `${tool.name}: required names a property`);
    assert.equal(tool.inputSchema.additionalProperties, false);
  }
  assert.deepEqual(toolDescriptors().filter(tool => tool.annotations.readOnlyHint).map(tool => tool.name), ['list_apps', 'get_app_state']);
  assert.deepEqual(missingArguments('click', {}), ['app']);
  assert.deepEqual(missingArguments('drag', { app: 'Notes', from_x: 1, from_y: 2 }), ['to_x', 'to_y']);
  assert.deepEqual(missingArguments('list_apps', undefined), []);
  const hostile = toolCode('type_text', { app: 'Notes', text: '"); process.exit(); ("', sneaky: 'await evil()' });
  assert(hostile.includes(JSON.stringify({ app: 'Notes', text: '"); process.exit(); ("' })), 'arguments are embedded as one JSON literal');
  assert(!hostile.includes('sneaky') && !hostile.includes('evil'), 'unknown arguments are dropped');
  assert(toolCode('click', { app: 'Notes', element_index: 3 }).includes('await sky.click(a); nodeRepl.write((await sky.get_app_state({ app: a.app })).text);'));
  assert(!toolCode('list_apps', {}).includes('get_app_state'));
  assert.doesNotThrow(() => new Function(`return async () => { ${toolCode('get_app_state', { app: 'Notes', screenshot: true })} }`), 'generated code parses');
  assert.equal(appPaths({}, '/X/ChatGPT.app/Contents/Resources/cua_node/bin/node').app, '/X/ChatGPT.app');
  assert.equal(appPaths({}, '/usr/local/bin/node').app, '/Applications/ChatGPT.app');
  assert.equal(appPaths({ CLUADEX_APP: '/Y/ChatGPT.app' }, '/usr/local/bin/node').app, '/Y/ChatGPT.app');
  console.log('selftest ok');
}

/** `--check`: start the real relay and ask the runtime to list apps. Run it after a ChatGPT app update. */
function check() {
  const relay = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
    env: { ...process.env, CLUADEX_APPROVAL: 'deny' }, stdio: ['pipe', 'pipe', 'inherit'] });
  const send = message => relay.stdin.write(`${JSON.stringify(message)}\n`);
  const finish = (ok, text) => { console.log(`${ok ? 'ok' : 'FAILED'}: ${text}`); relay.kill(); process.exit(ok ? 0 : 1); };
  const timer = setTimeout(() => finish(false, 'no answer from the runtime within 60 s'), 60_000);
  relay.on('exit', code => { clearTimeout(timer); finish(false, `relay exited with status ${code}`); });
  createInterface({ input: relay.stdout }).on('line', line => {
    const message = JSON.parse(line);
    if (message.id === 1) {
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    } else if (message.id === 2) {
      const names = message.result.tools.map(tool => tool.name);
      const expected = [...Object.keys(TOOLS), 'js', 'js_reset'];
      if (names.join() !== expected.join()) finish(false, `unexpected tools: ${names.join(', ')}`);
      send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_apps', arguments: {} } });
    } else if (message.id === 3) {
      const text = (message.result?.content ?? []).map(part => part.text ?? '').join('\n');
      const apps = (text.match(/"id":/g) ?? []).length;
      finish(apps > 0 && !message.result.isError, apps > 0 ? `runtime answered, ${Object.keys(TOOLS).length + PUBLIC_TOOLS.size} tools, ${apps} apps listed` : text.slice(0, 300));
    }
  });
  send({ jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'cluadex-check', version: '0' } } });
}

try {
  if (process.argv.includes('--selftest')) selftest();
  else if (process.argv.includes('--check')) check();
  else main();
} catch (error) {
  log(error.message);
  process.exit(1);
}
