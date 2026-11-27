const systemKeys = new Set([
  'cmd+shift+esc',
  'cmd+shift+q',
  'cmd+opt+shift+q',
  'cmd+ctrl+q',
  'cmd+opt+esc',
  'cmd+space',
  'ctrl+space',
  'cmd+tab',
  'cmd+shift+tab',
  'cmd+opt+d',
  'cmd+ctrl+f',
  'cmd+opt+shift+esc',
  'cmd+shift+3',
  'cmd+shift+4',
  'cmd+shift+5',
  'cmd+shift+6',
  'cmd+ctrl+shift+3',
  'cmd+ctrl+shift+4',
  'cmd+ctrl+power',
  'ctrl+opt+power',
  'cmd+opt+power',
  'ctrl+up',
  'ctrl+down',
  'ctrl+left',
  'ctrl+right',
]);
const otherSystemKeys = new Set([
  'opt+space',
  'opt+tab',
  'opt+shift+tab',
  'ctrl+opt+tab',
  'ctrl+esc',
  'opt+f1',
  'ctrl+opt+backspace',
  'opt+f2',
  'opt+f3',
  'opt+f4',
  'ctrl+opt+delete',
  'ctrl+opt+del',
  'ctrl+shift+esc',
  'ctrl+opt+t',
  'ctrl+opt+l',
  'ctrl+opt+up',
  'ctrl+opt+down',
  'ctrl+opt+left',
  'ctrl+opt+right',
  'print',
  'shift+print',
  'opt+print',
  ...Array.from({ length: 12 }, (_, index) => `ctrl+opt+f${index + 1}`),
]);
const modifierNames = {
  command: 'cmd',
  meta: 'cmd',
  super: 'cmd',
  win: 'cmd',
  windows: 'cmd',
  lwin: 'cmd',
  rwin: 'cmd',
  logo: 'cmd',
  mod4: 'cmd',
  '⌘': 'cmd',
  control: 'ctrl',
  ctl: 'ctrl',
  '⌃': 'ctrl',
  option: 'opt',
  alt: 'opt',
  '⌥': 'opt',
  '⇧': 'shift',
  escape: 'esc',
};
export function systemShortcut(keys, platform = process.platform) {
  const parts = keys
    .toLowerCase()
    .replace(/\s/g, '')
    .split('+')
    .map((part) => modifierNames[part.trim()] ?? part.trim());
  const key = parts.pop() ?? '';
  const pressed = [...parts, key];
  return (
    (platform !== 'darwin' &&
      (pressed.includes('cmd') || pressed.includes('print') || pressed.includes('sysrq'))) ||
    [...(platform === 'darwin' ? systemKeys : otherSystemKeys)].some((blocked) => {
      const needed = blocked.split('+');
      return needed.at(-1) === key && needed.slice(0, -1).every((part) => parts.includes(part));
    })
  );
}

function leaf(id) {
  return id.trim().toLowerCase().split(/[\\/]/).at(-1) ?? '';
}

export function appKey(id) {
  return leaf(id).replace(/\.(exe|desktop)$/, '');
}

const blockedApps = [
  [/^(dev\.nod\.desktop(\..+)?|com\.github\.electron|io\.n8n\.nod|nod)$/, 'Nod itself'],
  [
    /^(com\.apple\.terminal|com\.googlecode\.iterm2|dev\.warp\.warp.*|com\.mitchellh\.ghostty|net\.kovidgoyal\.kitty|(io|org)\.alacritty|co\.zeit\.hyper|com\.github\.wez\.wezterm|org\.wezfurlong\.wezterm|com\.raphaelamorim\.rio|org\.tabby|wt|windowsterminal|cmd|powershell(_ise)?|pwsh|conhost|openconsole|wsl|bash|mintty|org\.gnome\.terminal|org\.gnome\.console|org\.gnome\.ptyxis|ptyxis|kgx|gnome-terminal(-server)?|org\.kde\.konsole|konsole|org\.kde\.yakuake|yakuake|guake|xterm|uxterm|com\.gexperts\.tilix|tilix|terminator|kitty|alacritty|wezterm|xfce4-terminal|lxterminal|terminology|foot|x-terminal-emulator)$/,
    'a terminal',
  ],
  [
    /^(com\.apple\.scripteditor2|com\.apple\.automator|com\.apple\.shortcuts|com\.raycast\.macos|com\.runningwithcrayons\.alfred|com\.docker\.docker|docker desktop|wscript|cscript|mshta|rundll32|regsvr32|python[w0-9.]*|node)$/,
    'an app that runs scripts or commands',
  ],
  [
    /^(com\.apple\.systempreferences|com\.apple\.settings|com\.apple\.keychainaccess|com\.apple\.activitymonitor|com\.apple\.diskutility|com\.apple\.securityagent|com\.apple\.migrateassistant|com\.apple\.installer|com\.apple\.loginwindow|systemsettings|control|mmc|regedit|regedt32|taskmgr|gpedit|msconfig|secpol|lusrmgr|compmgmt|services|eventvwr|devmgmt|diskmgmt|consent|credentialuibroker|logonui|lockapp|org\.gnome\.settings|gnome-control-center|org\.kde\.systemsettings|org\.gnome\.seahorse\.application|seahorse|org\.gnome\.diskutility|gnome-disks|org\.gnome\.systemmonitor|gnome-system-monitor|org\.kde\.plasma-systemmonitor|org\.kde\.kwalletmanager5?|kwalletmanager5?|polkit-.*|org\.gnome\.software|software-properties-.*|synaptic|sechealthui|securityhealthsystray|gcr-prompter|pinentry.*|quickassist|msra|mstsc|logoff|tsdiscon|shutdown|schtasks|certutil|reg|sc|net1?|wmic|msiexec|systemreset|rstrui|credwiz|systemproperties.*|msdt|resmon|perfmon|netplwiz|useraccountcontrolsettings|rekeywiz|sysdm)$/,
    'system settings or security',
  ],
  [
    /^(searchhost|searchapp|searchui|startmenuexperiencehost|shellexperiencehost|applicationframehost|gnome-shell|org\.gnome\.shell.*|plasmashell|krunner|org\.kde\.krunner)$/,
    'the system shell or search, which can start any app',
  ],
  [
    /^(com\.apple\.finder|explorer|org\.gnome\.nautilus|nautilus|org\.kde\.dolphin|dolphin|nemo|thunar|pcmanfm|caja)$/,
    'a file manager; use the files tool for local files',
  ],
  [
    /(^com\.apple\.passwords$)|1password|onepassword|bitwarden|dashlane|lastpass|keepass|nordpass|enpass|proton\.pass|keeper/,
    'a password manager',
  ],
  [/ledger\.live|exodus|electrum|trezor|metamask|phantom|wallet/, 'a crypto wallet'],
];
const viewOnlyApps = [
  [
    /^(com\.google\.chrome.*|com\.apple\.safari.*|company\.thebrowser\..*|org\.mozilla\.(?!thunderbird).*|com\.microsoft\.edge.*|com\.brave\.browser.*|com\.operasoftware\..*|com\.vivaldi\..*|app\.zen-browser\..*|com\.kagi\..*|ai\.perplexity\..*|com\.openai\.atlas.*|org\.chromium\..*|chrome|google-chrome(-stable|-beta)?|chromium(-browser)?|msedge|microsoft-edge(-stable)?|firefox(-esr)?|brave(-browser)?|opera|vivaldi(-stable)?|arc|librewolf|zen|org\.gnome\.epiphany|epiphany)$/,
    "a web browser; use Nod's own browser for websites",
  ],
  [
    /^(com\.microsoft\.vscode.*|com\.visualstudio\.code.*|com\.todesktop\..*|com\.exafunction\..*|dev\.zed\..*|com\.jetbrains\..*|com\.apple\.dt\.xcode|com\.stablyai\.orca|code(-insiders)?|cursor|windsurf|zed|devenv|jetbrains-.*|idea64|pycharm64|webstorm64)$/,
    'a code editor that can run commands',
  ],
];

export function computerAppRule(bundleId, keptOut = []) {
  const names = [appKey(bundleId), leaf(bundleId)];
  const matches = (pattern) => names.some((name) => pattern.test(name));
  if (keptOut.some((entry) => names.includes(appKey(entry))))
    return { kind: 'blocked', why: 'an app the owner keeps Nod out of' };
  for (const [pattern, why] of blockedApps) if (matches(pattern)) return { kind: 'blocked', why };
  for (const [pattern, why] of viewOnlyApps) if (matches(pattern)) return { kind: 'view', why };
  return { kind: 'use' };
}
