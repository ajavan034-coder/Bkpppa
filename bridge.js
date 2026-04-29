import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export const config = {
  api: { bodyParser: false },
  supportsResponseStreaming: true,
  maxDuration: 60,
};

// مقدار این رو توی پنل ورسل روی DESTINATION_ADDR تنظیم کن
const REMOTE_ENDPOINT = (process.env.DESTINATION_ADDR || "").replace(/\/$/, "");

const BLOCKED_META = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "forwarded",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-port",
]);

export default async function startBridge(request, response) {
  if (!REMOTE_ENDPOINT) {
    response.statusCode = 500;
    return response.end("Global Config Error: Endpoint not defined.");
  }

  try {
    const finalPath = REMOTE_ENDPOINT + request.url;
    const outboundHeaders = {};
    let sourceId = null;

    for (const [attr, val] of Object.entries(request.headers)) {
      const keyLow = attr.toLowerCase();
      
      // این‌ها هدرهای سیستمی هستن و نمیشه اسمشون رو عوض کرد، ولی منطق فیلتر رو ریرایت کردم
      if (BLOCKED_META.has(keyLow) || keyLow.startsWith("x-vercel-")) continue;

      if (keyLow === "x-real-ip") { 
        sourceId = val; 
        continue; 
      }
      if (keyLow === "x-forwarded-for") { 
        if (!sourceId) sourceId = val; 
        continue; 
      }
      
      outboundHeaders[keyLow] = Array.isArray(val) ? val.join(", ") : val;
    }

    if (sourceId) outboundHeaders["x-forwarded-for"] = sourceId;

    const opMethod = request.method;
    const needsPayload = opMethod !== "GET" && opMethod !== "HEAD";

    const connOptions = { method: opMethod, headers: outboundHeaders, redirect: "manual" };
    
    if (needsPayload) {
      connOptions.body = Readable.toWeb(request);
      connOptions.duplex = "half";
    }

    const remoteStream = await fetch(finalPath, connOptions);

    response.statusCode = remoteStream.status;
    
    for (const [sKey, sVal] of remoteStream.headers) {
      if (sKey.toLowerCase() === "transfer-encoding") continue;
      try { response.setHeader(sKey, sVal); } catch (e) {}
    }

    if (remoteStream.body) {
      await pipeline(Readable.fromWeb(remoteStream.body), response);
    } else {
      response.end();
    }
  } catch (err) {
    console.error("Stream Fault:", err);
    if (!response.headersSent) {
      response.statusCode = 502;
      response.end("Critical: Remote link interrupted.");
    }
  }
}
