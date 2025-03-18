// api-server.js
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const { PDFLoader } = require("langchain/document_loaders/fs/pdf");
const { RecursiveCharacterTextSplitter } = require("langchain/text_splitter");
const { GoogleGenerativeAIEmbeddings } = require("@langchain/google-genai");
const { FaissStore } = require("@langchain/community/vectorstores/faiss");
const { GoogleGenerativeAI } = require("@google/generative-ai");
require("dotenv").config();

// Initialize Express app
const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Configure multer for file uploads
const upload = multer({
  dest: "uploads/",
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB limit
});

// Store conversation and vector store
let vectorStore = null;
let genAI = null;
let model = null;
let chatHistory = [];
let isProcessing = false;

// Extract text from PDFs
async function getPdfText(filePaths) {
  let text = "";
  console.log("Extracting text from PDFs...");

  for (const filePath of filePaths) {
    console.log(`Processing: ${filePath}`);
    const loader = new PDFLoader(filePath);
    const docs = await loader.load();

    for (const doc of docs) {
      if (doc.pageContent) {
        text += doc.pageContent;
      }
    }
  }

  console.log("Text extraction complete");
  return text;
}

// Split text into chunks
async function getTextChunks(text) {
  console.log("Splitting text into chunks...");
  const textSplitter = new RecursiveCharacterTextSplitter({
    chunkSize: 1000,
    chunkOverlap: 200,
  });

  const chunks = await textSplitter.splitText(text);
  console.log(`Created ${chunks.length} text chunks`);
  return chunks;
}

// Create vector store from text chunks
async function getVectorStore(textChunks) {
  console.log("Creating embeddings and vector store...");
  const embeddings = new GoogleGenerativeAIEmbeddings({
    apiKey: process.env.GOOGLE_API_KEY,
    model: "models/text-embedding-004",
  });

  return await FaissStore.fromTexts(textChunks, {}, embeddings);
}

// Initialize Gemini model
function initializeGeminiModel() {
  console.log("Initializing Gemini model...");
  genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
  model = genAI.getGenerativeModel({ model: "gemini-1.5-pro" });
  console.log("Model initialized successfully!");
  return true;
}

// Process PDF files
async function processPDFs(filePaths) {
  try {
    isProcessing = true;
    console.log("Starting PDF processing...");
    const rawText = await getPdfText(filePaths);
    const textChunks = await getTextChunks(rawText);
    vectorStore = await getVectorStore(textChunks);

    // Initialize model
    initializeGeminiModel();

    // Create data directory for vector store persistence if it doesn't exist
    if (!fs.existsSync("./data")) {
      fs.mkdirSync("./data");
    }

    // Save vector store to disk
    await vectorStore.save("./data/faiss_index");

    console.log("PDFs processed successfully!");
    isProcessing = false;
    return true;
  } catch (error) {
    console.error("Error processing PDFs:", error);
    isProcessing = false;
    return false;
  }
}

// Clean up uploaded files
function cleanupFiles(files) {
  files.forEach((file) => {
    fs.unlink(file.path, (err) => {
      if (err) {
        console.error(`Error deleting file ${file.path}:`, err);
      } else {
        console.log(`Successfully deleted file ${file.path}`);
      }
    });
  });
}

// API Routes

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({
    status: "online",
    modelInitialized: !!model,
    vectorStoreInitialized: !!vectorStore,
    isProcessing: isProcessing,
  });
});

// Upload and process PDFs
app.post("/upload", upload.array("files"), async (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res
      .status(400)
      .json({ success: false, message: "No files uploaded" });
  }

  try {
    const filePaths = req.files.map((file) => file.path);

    // Process PDFs asynchronously and send immediate response
    res.json({
      success: true,
      message: "PDF processing started",
      files: req.files.map((f) => f.originalname),
    });

    // Process PDFs in the background
    await processPDFs(filePaths);

    // Clean up files after processing
    cleanupFiles(req.files);
  } catch (error) {
    console.error("Error in upload:", error);
    res
      .status(500)
      .json({ success: false, message: "Error processing upload" });
  }
});

// Ask a question with streaming response
app.post("/ask", async (req, res) => {
  // Get question from either query parameter or request body
  const question = req.query.question || (req.body && req.body.question);

  if (!question) {
    return res
      .status(400)
      .json({ success: false, message: "Question is required" });
  }

  if (!vectorStore || !model) {
    return res.status(400).json({
      success: false,
      message: "PDF documents have not been processed yet",
    });
  }

  // Set up response for streaming
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  try {
    // Send start event
    res.write(`data: ${JSON.stringify({ type: "start" })}\n\n`);

    // Get relevant documents
    const relevantDocs = await vectorStore.similaritySearch(question, 3);
    const contextText = relevantDocs.map((doc) => doc.pageContent).join("\n\n");

    // Send context event
    res.write(
      `data: ${JSON.stringify({
        type: "context",
        count: relevantDocs.length,
      })}\n\n`
    );

    // Prepare chat history
    const historyText = chatHistory
      .map((h) => `User: ${h.question}\nAssistant: ${h.answer}`)
      .join("\n\n");

    // Create prompt with context and history
    const prompt = `I'll answer your question based on the following information:

Context from documents:
${contextText}

${historyText ? `Previous conversation:\n${historyText}\n` : ""}

User's question: ${question}

Please provide a detailed and accurate answer based only on the information provided in the context.`;

    // Generate streaming response
    const result = await model.generateContentStream(prompt);

    let fullResponse = "";

    // Stream each chunk as it arrives
    for await (const chunk of result.stream) {
      const chunkText = chunk.text();
      fullResponse += chunkText;

      // Send chunk event
      res.write(
        `data: ${JSON.stringify({
          type: "chunk",
          text: chunkText,
        })}\n\n`
      );
    }

    // Store in chat history
    chatHistory.push({ question, answer: fullResponse });

    // Send complete event
    res.write(
      `data: ${JSON.stringify({
        type: "complete",
        fullText: fullResponse,
      })}\n\n`
    );

    // End the response
    res.end();
  } catch (error) {
    console.error("Error processing question:", error);
    res.write(
      `data: ${JSON.stringify({
        type: "error",
        message: "Error generating response",
      })}\n\n`
    );
    res.end();
  }
});

// Clear conversation history
app.post("/clear-history", (req, res) => {
  chatHistory = [];
  res.json({ success: true, message: "Conversation history cleared" });
});

// Load saved vector store if it exists
async function loadSavedVectorStore() {
  try {
    if (fs.existsSync("./data/faiss_index")) {
      console.log("Loading saved vector store...");
      const embeddings = new GoogleGenerativeAIEmbeddings({
        apiKey: process.env.GOOGLE_API_KEY,
        model: "models/text-embedding-004",
      });

      vectorStore = await FaissStore.load("./data/faiss_index", embeddings);
      initializeGeminiModel();
      console.log("Vector store loaded successfully!");
      return true;
    }
    return false;
  } catch (error) {
    console.error("Error loading saved vector store:", error);
    return false;
  }
}

// Create uploads directory if it doesn't exist
if (!fs.existsSync("./uploads")) {
  fs.mkdirSync("./uploads");
}

// Start the server
app.listen(port, "0.0.0.0", async () => {
  console.log(`Server running on port ${port}`);

  // Check if API key is set
  if (!process.env.GOOGLE_API_KEY) {
    console.error("Error: GOOGLE_API_KEY is not set in .env file");
    return;
  }

  // Try to load saved vector store
  await loadSavedVectorStore();
});
