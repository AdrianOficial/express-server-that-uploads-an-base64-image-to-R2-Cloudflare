require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { NodeHttpHandler } = require("@smithy/node-http-handler");
const https = require("https");
const express = require("express");
const { S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const mime = require("mime-types");
const crypto = require("crypto");
const cors = require("cors");

const app = express();
app.use(express.json({ limit: "25mb" }));

app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  maxAge: 86400,
  optionsSuccessStatus: 204,
}));

const {
    R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY,
    R2_ACCOUNT_ID,
    R2_BUCKET,
    R2_PUBLIC_BASE_URL,
    PORT = 3000,
} = process.env;

if (!R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_ACCOUNT_ID || !R2_BUCKET) {
    console.error("Missing required R2 env vars.");
    process.exit(1);
}

function joinUrl(base, key) {
	const b = base.replace(/\/+$/, "");
	const encodedKey = key.split("/").map(encodeURIComponent).join("/");
	return `${b}/${encodedKey}`;
}

const s3 = new S3Client({
    region: "auto",
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
        accessKeyId: R2_ACCESS_KEY_ID,
        secretAccessKey: R2_SECRET_ACCESS_KEY,
    },
    forcePathStyle: true,
	  requestHandler: new NodeHttpHandler({
		httpsAgent: new https.Agent({ rejectUnauthorized: false }) // ⚠️ dev only
	  }),
});

function randToken(len = 8) {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    const buf = crypto.randomBytes(len);
    return Array.from(buf, (b) => alphabet[b % alphabet.length]).join("");
}

function parseBase64(input) {
    if (typeof input !== "string" || !input.length) {
        throw new Error("Empty base64 string");
    }

    let base64 = input;
    let mimeType = "";

    const match = input.match(/^data:([a-zA-Z0-9+\-_.\/]+);base64,(.+)$/);
    if (match) {
        mimeType = match[1];
        base64 = match[2];
    }

    base64 = base64.replace(/\s/g, "");

    if (!/^[A-Za-z0-9+/]+=*$/.test(base64)) {
        throw new Error("Invalid base64 data");
    }

    const buffer = Buffer.from(base64, "base64");
    return { buffer, mimeType };
}

app.post("/upload", async (req, res) => {
    try {
        const { imageBase64, folder = "" } = req.body || {};
        if (!imageBase64) return res.status(400).json({ ok: false, error: "Missing 'imageBase64'" });

        const { buffer, mimeType } = parseBase64(imageBase64);
        const contentType = mimeType || "application/octet-stream";
        const safeExts = new Set(["png", "jpg", "jpeg", "webp"]);
        let ext = mime.extension(contentType) || "png";
        if (!safeExts.has(ext)) ext = "png";

        const key = `${folder ? folder.replace(/\/+$/, "") + "/" : ""}${randToken(8)}-${randToken(6)}.${ext}`;

        await s3.send(
            new PutObjectCommand({
                Bucket: R2_BUCKET,
                Key: key,
                Body: buffer,
                ContentType: contentType,
            })
        );

        const url = R2_PUBLIC_BASE_URL
            ? joinUrl(R2_PUBLIC_BASE_URL, key)
            : await getSignedUrl(s3, new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }), { expiresIn: 3600 });

        res.json({ ok: true, key, url, contentType, size: buffer.length });
    } catch (e) {
        console.error(e);
        res.status(400).json({ ok: false, error: e.message || "Upload failed" });
    }
});

app.get("/health", (_req, res) => res.json({ ok: true }));
app.listen(Number(PORT), () => console.log(`Up on http://localhost:${PORT}`));

app.listen(Number(PORT), () => {
    console.log(`Upload server on http://localhost:${PORT}`);
});
