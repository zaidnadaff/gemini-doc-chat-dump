#!/usr/bin/env node
const axios = require("axios");
const FormData = require("form-data");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const readline = require("readline");

const API_URL = "http://localhost:3000";
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

let serverProcess = null;

// Start the API server
function startServer() {
  console.log("Starting API server...");
  serverProcess = spawn("node", ["api-server.js"]);

  serverProcess.stdout.on("data", (data) => {
    process.stdout.write(data.toString());
  });

  serverProcess.stderr.on("data", (data) => {
    process.stderr.write(data.toString());
  });

  serverProcess.on("close", (code) => {
    console.log(`Server process exited with code ${code}`);
  });
}

// Stop the API server
function stopServer() {
  if (serverProcess) {
    console.log("Stopping API server...");
    serverProcess.kill();
    serverProcess = null;
  }
}

// Upload PDF files
async function uploadFiles() {
  const files = await new Promise((resolve) =>
    rl.question("Enter paths to PDF files (comma separated): ", resolve)
  );

  const filePaths = files.split(",").map((f) => f.trim());
  const form = new FormData();

  filePaths.forEach((filePath) => {
    form.append("files", fs.createReadStream(filePath));
  });

  try {
    const response = await axios.post(`${API_URL}/upload`, form, {
      headers: form.getHeaders(),
    });
    console.log("Upload response:", response.data);
  } catch (error) {
    console.error("Upload failed:", error.response?.data || error.message);
  }
}

// Ask a question and stream the response
async function askQuestion() {
  const question = await new Promise((resolve) =>
    rl.question("Enter your question: ", resolve)
  );

  try {
    const response = await axios.post(
      `${API_URL}/ask`,
      { question },
      {
        responseType: "stream",
      }
    );

    console.log("\nStreaming response:");
    response.data.on("data", (chunk) => {
      const data = chunk.toString().trim();
      if (data) {
        const event = JSON.parse(data.replace("data: ", ""));
        switch (event.type) {
          case "start":
            console.log("Starting response...");
            break;
          case "context":
            console.log(`Found ${event.count} relevant documents`);
            break;
          case "chunk":
            process.stdout.write(event.text);
            break;
          case "complete":
            console.log("\n\nResponse complete");
            break;
          case "error":
            console.error("\nError:", event.message);
            break;
        }
      }
    });
  } catch (error) {
    console.error(
      "Error asking question:",
      error.response?.data || error.message
    );
  }
}

// Clear conversation history
async function clearHistory() {
  try {
    const response = await axios.post(`${API_URL}/clear-history`);
    console.log("History cleared:", response.data);
  } catch (error) {
    console.error(
      "Error clearing history:",
      error.response?.data || error.message
    );
  }
}

// Check server health
async function checkHealth() {
  try {
    const response = await axios.get(`${API_URL}/health`);
    console.log("Server health:", response.data);
  } catch (error) {
    console.error(
      "Error checking health:",
      error.response?.data || error.message
    );
  }
}

// Main menu
async function showMenu() {
  console.log("\n===== PDF QA System =====");
  console.log("1. Start API server");
  console.log("2. Upload PDF files");
  console.log("3. Ask a question");
  console.log("4. Clear conversation history");
  console.log("5. Check server health");
  console.log("6. Stop API server");
  console.log("0. Exit");

  const choice = await new Promise((resolve) =>
    rl.question("\nEnter your choice: ", resolve)
  );

  switch (choice) {
    case "1":
      startServer();
      break;
    case "2":
      await uploadFiles();
      break;
    case "3":
      await askQuestion();
      break;
    case "4":
      await clearHistory();
      break;
    case "5":
      await checkHealth();
      break;
    case "6":
      stopServer();
      break;
    case "0":
      stopServer();
      process.exit(0);
    default:
      console.log("Invalid choice");
  }

  setTimeout(showMenu, 100);
}

// Start the CLI
function startCLI() {
  console.log("PDF QA System CLI");
  showMenu();
}

// Handle process exit
process.on("SIGINT", () => {
  stopServer();
  process.exit(0);
});

// Start the CLI
startCLI();
