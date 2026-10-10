const deadline = Date.now() + 120000;
let ready = false;
while (Date.now() < deadline) {
  try {
    const [web, api] = await Promise.all([
      fetch("http://localhost:3000"),
      fetch("http://127.0.0.1:3001/health"),
    ]);
    ready = web.ok && api.ok;
    await Promise.all([web.arrayBuffer(), api.arrayBuffer()]);
    if (ready) break;
  } catch {}
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
if (!ready) throw new Error("Application servers did not become ready in 120 seconds.");
console.log("Web and API ready.");
