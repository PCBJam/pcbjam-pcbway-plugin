// npm run mock -- serves the mock PCBWay on :3058. For a manual run in PCBJam,
// expose it over https (e.g. `cloudflared tunnel --url http://127.0.0.1:3058`)
// and pass that origin: PUBLIC_ORIGIN=https://<name>.trycloudflare.com npm run mock
import { startPcbwayMock } from "./pcbway-mock.mjs";
const mock = await startPcbwayMock({ port: Number(process.env.PORT ?? 3058), publicOrigin: process.env.PUBLIC_ORIGIN, contentType: process.env.MOCK_CONTENT_TYPE });
console.log(`Mock PCBWay on ${mock.origin}${process.env.PUBLIC_ORIGIN ? " (public " + process.env.PUBLIC_ORIGIN + ")" : ""}`);
