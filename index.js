import express from "express";
import cors from "cors";
import multer from "multer";
import dotenv from "dotenv";
import { supabase, supabaseAdmin } from "./supabase.js";
import OpenAI from "openai";
import fetch from "node-fetch";  // IMPORTANT for keep-alive ping

dotenv.config();

const app = express();

/* ----------------------------------------------------
   KEEP RENDER SERVER ALIVE (Prevents 503 cold-start)
---------------------------------------------------- */
setInterval(() => {
  fetch("https://buddyhelp-backend.onrender.com/health").catch(() => {});
}, 300000); // ping every 5 min

/* ----------------------------------------------------
   CORS — FIXED FOR GITHUB PAGES
---------------------------------------------------- */
app.use(
  cors({
    origin: [
      "http://localhost:3000",
      "http://localhost:5500",
      "http://127.0.0.1:5500",
      "https://shivanew-hadoop.github.io",
      "https://shivanew-hadoop.github.io/buddyhelp-frontend"
    ],
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true
  })
);

// Explicit preflight
app.options("*", (req, res) => {
  res.header("Access-Control-Allow-Origin", req.headers.origin);
  res.header(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, DELETE, OPTIONS"
  );
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.sendStatus(200);
});

/* ----------------------------------------------------
   Middleware
---------------------------------------------------- */
app.use(express.json());
const upload = multer({ storage: multer.memoryStorage() });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* ----------------------------------------------------
   Health Check
---------------------------------------------------- */
app.get("/health", (req, res) => {
  res.status(200).send("OK");
});

/* ----------------------------------------------------
   SIGNUP
---------------------------------------------------- */
app.post("/signup", async (req, res) => {
  try {
    const { email, password, name, phone, country } = req.body;

    const { data: user, error } = await supabase.auth.signUp({ email, password });
    if (error) return res.status(400).json({ error: error.message });

    await supabaseAdmin.from("user_meta").insert([
      { id: user.user.id, name, phone, country, status: "PENDING" }
    ]);

    await supabaseAdmin.from("credits").insert([
      { user_id: user.user.id, remaining_seconds: 0 }
    ]);

    res.json({ message: "Account created. Pending admin approval." });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Signup failed" });
  }
});

/* ----------------------------------------------------
   LOGIN  (FINAL WORKING VERSION)
---------------------------------------------------- */
app.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return res.status(400).json({ error: "Invalid login" });

    const user = data.user;
    const uid = user.id;

    const { data: meta, error: metaErr } = await supabaseAdmin
      .from("user_meta")
      .select("*")
      .eq("id", uid)
      .single();

    if (metaErr) return res.json({ error: "User profile not found" });
    if (meta.status === "PENDING") return res.json({ error: "Pending approval" });
    if (meta.status === "BLOCKED") return res.json({ error: "Blocked by admin" });

    const { data: credit } = await supabaseAdmin
      .from("credits")
      .select("remaining_seconds")
      .eq("user_id", uid)
      .single();

    return res.json({
      token: data.session.access_token,
      user: {
        id: uid,
        email: user.email,
        name: meta.name,
        phone: meta.phone,
        country: meta.country,
        status: meta.status,
        credits: credit?.remaining_seconds || 0
      }
    });

  } catch (err) {
    console.error("LOGIN ERROR:", err);
    return res.status(500).json({ error: "Login failed" });
  }
});

/* ----------------------------------------------------
   ADMIN: Get All Users
---------------------------------------------------- */
app.get("/admin/users", async (req, res) => {
  const { data: meta, error } = await supabaseAdmin
    .from("user_meta")
    .select("*");

  if (error) return res.status(500).json({ error });

  const users = [];

  for (const row of meta) {
    const { data: credit } = await supabaseAdmin
      .from("credits")
      .select("remaining_seconds")
      .eq("user_id", row.id)
      .single();

    users.push({
      ...row,
      credits: credit || { remaining_seconds: 0 }
    });
  }

  return res.json({ users });
});

/* ----------------------------------------------------
   ADMIN: Approve
---------------------------------------------------- */
app.post("/admin/approve", async (req, res) => {
  await supabaseAdmin
    .from("user_meta")
    .update({ status: "ACTIVE" })
    .eq("id", req.body.userId);

  res.json({ message: "Approved" });
});

/* ----------------------------------------------------
   ADMIN: Add Credits
---------------------------------------------------- */
app.post("/admin/add-credits", async (req, res) => {
  const { userId, seconds } = req.body;

  const { data } = await supabaseAdmin
    .from("credits")
    .select("*")
    .eq("user_id", userId)
    .single();

  if (!data) {
    await supabaseAdmin.from("credits").insert({
      user_id: userId,
      remaining_seconds: seconds
    });
  } else {
    await supabaseAdmin
      .from("credits")
      .update({ remaining_seconds: data.remaining_seconds + seconds })
      .eq("user_id", userId);
  }

  res.json({ message: "Credits added" });
});

/* ----------------------------------------------------
   Credits Check
---------------------------------------------------- */
app.get("/credits/:uid", async (req, res) => {
  const { data } = await supabaseAdmin
    .from("credits")
    .select("remaining_seconds")
    .eq("user_id", req.params.uid)
    .single();

  res.json({ remaining: data.remaining_seconds });
});

/* ----------------------------------------------------
   Tick Credit
---------------------------------------------------- */
app.post("/tick", async (req, res) => {
  const { userId } = req.body;

  const { data } = await supabaseAdmin
    .from("credits")
    .select("*")
    .eq("user_id", userId)
    .single();

  if (data.remaining_seconds <= 0)
    return res.json({ exhausted: true });

  await supabaseAdmin
    .from("credits")
    .update({ remaining_seconds: data.remaining_seconds - 1 })
    .eq("user_id", userId);

  res.json({ exhausted: false });
});

/* ----------------------------------------------------
   Whisper Audio → Text
---------------------------------------------------- */
app.post("/whisper", upload.single("audio"), async (req, res) => {
  const f = req.file;
  if (!f) return res.json({ text: "" });

  const result = await openai.audio.transcriptions.create({
    file: f.buffer,
    model: "gpt-4o-transcribe",
    response_format: "json"
  });

  res.json({ text: result.text });
});

/* ----------------------------------------------------
   Chat (stream)
---------------------------------------------------- */
app.post("/chat", async (req, res) => {
  const { prompt } = req.body;

  const stream = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    stream: true,
    messages: [{ role: "user", content: prompt }]
  });

  res.setHeader("Content-Type", "text/plain; charset=utf-8");

  for await (const chunk of stream) {
    const txt = chunk.choices?.[0]?.delta?.content || "";
    if (txt) res.write(txt);
  }
  res.end();
});

/* ----------------------------------------------------
   TEMP: Create Admin
---------------------------------------------------- */
app.post("/create-admin", async (req, res) => {
  const email = "shiva.nelikanti@gmail.com";
  const password = "Shavi@1234";

  const { data: user, error } = await supabase.auth.signUp({ email, password });
  if (error) return res.status(400).json({ error });

  await supabaseAdmin.from("user_meta").insert([
    {
      id: user.user.id,
      name: "Admin User",
      phone: "00000",
      country: "Admin",
      status: "ACTIVE"
    }
  ]);

  await supabaseAdmin.from("credits").insert([
    { user_id: user.user.id, remaining_seconds: 999999 }
  ]);

  res.json({ success: true, adminId: user.user.id });
});

/* ----------------------------------------------------
   Start Server
---------------------------------------------------- */
app.listen(process.env.PORT || 3000, () => {
  console.log("Backend running on port " + (process.env.PORT || 3000));
});
