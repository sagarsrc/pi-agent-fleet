import { startCanvasServer } from "../src/canvas.js";

const server = await startCanvasServer({ getFleet: () => undefined, cwd: process.cwd(), port: 52000 });
console.log(`fleet canvas: ${server.url}?demo=1`);
