export function workspaceNetwork(inspectedNetworks: string) {
  const unavailable = () => new Error('Start the Nod workspace on a normal Docker network first.');
  let networks: unknown;
  try {
    networks = JSON.parse(inspectedNetworks);
  } catch {
    throw unavailable();
  }
  if (!networks || typeof networks !== 'object' || Array.isArray(networks)) throw unavailable();
  const entries = Object.entries(networks);
  if (entries.length !== 1) throw unavailable();
  const [name, connection] = entries[0];
  if (
    !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/.test(name) ||
    ['host', 'none'].includes(name) ||
    !connection ||
    typeof connection !== 'object' ||
    Array.isArray(connection) ||
    !('NetworkID' in connection) ||
    typeof connection.NetworkID !== 'string' ||
    !/^[a-f0-9]{64}$/.test(connection.NetworkID)
  )
    throw unavailable();
  return name;
}
