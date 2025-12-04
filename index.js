import express from "express";
import cors from "cors";
import multer from "multer";
import dotenv from "dotenv";
import { supabase, supabaseAdmin } from "./supabase.js";
import OpenAI from "openai";

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());
const upload = multer({ storage: multer.memoryStorage() });

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Signup
app.post("/signup", async (req, res) => {
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
});

// Login
app.post("/login", async (req, res) => {
  const { email, password } = req.body;
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return res.status(400).json({ error: "Invalid login" });

  const uid = data.user.id;

  const { data: meta } = await supabaseAdmin
    .from("user_meta")
    .select("*").eq("id", uid).single();

  if (meta.status === "PENDING") return res.json({ error: "Pending approval" });
  if (meta.status === "BLOCKED") return res.json({ error: "Blocked by admin" });

  res.json({ token: data.session.access_token, userId: uid });
});

// Admin get users
app.get("/admin/users", async (req, res) => {
  const { data } = await supabaseAdmin
    .from("user_meta")
    .select("*, credits(remaining_seconds)");
  res.json({ users: data });
});

// Admin approve
app.post("/admin/approve", async (req, res) => {
  await supabaseAdmin
    .from("user_meta")
    .update({ status: "ACTIVE" })
    .eq("id", req.body.userId);
  res.json({ message: "Approved" });
});

// Admin add credits
app.post("/admin/add-credits", async (req, res) => {
  const { userId, seconds } = req.body;
  const { data } = await supabaseAdmin
    .from("credits").select("*").eq("user_id", userId).single();

  if (!data) {
    await supabaseAdmin.from("credits")
      .insert({ user_id: userId, remaining_seconds: seconds });
  } else {
    await supabaseAdmin.from("credits")
      .update({ remaining_seconds: data.remaining_seconds + seconds })
      .eq("user_id", userId);
  }

  res.json({ message: "Credits added" });
});

// Check credits
app.get("/credits/:uid", async (req, res) => {
  const { data } = await supabaseAdmin
    .from("credits")
    .select("remaining_seconds")
    .eq("user_id", req.params.uid)
    .single();
  res.json({ remaining: data.remaining_seconds });
});

// Tick
app.post("/tick", async (req, res) => {
  const { userId } = req.body;
  const { data } = await supabaseAdmin
    .from("credits").select("*").eq("user_id", userId).single();

  if (data.remaining_seconds <= 0)
    return res.json({ exhausted: true });

  await supabaseAdmin.from("credits")
    .update({ remaining_seconds: data.remaining_seconds - 1 })
    .eq("user_id", userId);

  res.json({ exhausted: false });
});

// Whisper
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

// Chat
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

app.listen(process.env.PORT, () =>
  console.log("Backend running on port " + process.env.PORT)
);
