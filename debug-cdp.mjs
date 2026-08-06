import WebSocket from "ws";
import http from "http";

function getJson(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(d));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on("error", reject);
  });
}

const tabs = await getJson("http://127.0.0.1:9223/json");
const page = tabs.find((t) => t.url && t.url.includes("localhost:1420"));
if (!page) {
  console.log(
    "NO PAGE",
    tabs.map((t) => t.url),
  );
  process.exit(1);
}

console.log("Connecting", page.webSocketDebuggerUrl);
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 1;
const pending = {};

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const i = id++;
    pending[i] = { resolve, reject };
    ws.send(JSON.stringify({ id: i, method, params }));
  });
}

ws.on("message", (msg) => {
  const m = JSON.parse(msg.toString());
  if (m.id && pending[m.id]) pending[m.id].resolve(m.result);
  if (m.method === "Runtime.consoleAPICalled") {
    const text = (m.params.args || [])
      .map((a) => a.value ?? a.description)
      .join(" ");
    console.log("CONSOLE", m.params.type, text);
  }
  if (m.method === "Runtime.exceptionThrown") {
    console.log(
      "EXCEPTION",
      m.params.exceptionDetails?.exception?.description ||
        m.params.exceptionDetails?.text,
    );
  }
});

await new Promise((resolve) => ws.on("open", resolve));
await send("Runtime.enable");
await send("Console.enable");
await send("Page.reload", { ignoreCache: true });
await new Promise((r) => setTimeout(r, 3000));

const evalResult = await send("Runtime.evaluate", {
  expression: `({
    html: document.getElementById('root')?.innerHTML?.slice(0, 800),
    childCount: document.getElementById('root')?.childElementCount,
    bodyText: document.body?.innerText?.slice(0, 500),
    title: document.title
  })`,
  returnByValue: true,
});
console.log("DOM", JSON.stringify(evalResult?.result?.value, null, 2));

ws.close();
process.exit(0);
