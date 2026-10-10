// Child-only verification instrumentation. Any attempted network connection/listener fails immediately.
const net = require("node:net");
const effects = { connections: 0, listeners: 0 };
net.Socket.prototype.connect = function guardedConnect() {
  effects.connections++;
  throw new Error("runtime_probe_connection_forbidden");
};
net.Server.prototype.listen = function guardedListen() {
  effects.listeners++;
  throw new Error("runtime_probe_listener_forbidden");
};
process.once("exit", () => {
  process.stdout.write(`RUNTIME_PROBE_EFFECTS=${JSON.stringify(effects)}\n`);
});
