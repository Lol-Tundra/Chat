const http = require("http");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");
const Database = require("better-sqlite3");

// Setup SQLite DB
const db = new Database("chat.db");

db.prepare(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender TEXT,
    senderName TEXT, 
    clientId TEXT,     
    text TEXT,
    timestamp TEXT
  )
`).run();

// Serve index.html
const server = http.createServer((req, res) => {
  if (req.url === "/") {
    const filePath = path.join(__dirname, "index.html");
    fs.readFile(filePath, (err, data) => {
      if (err) {
        console.error("Error reading index.html:", err);
        res.writeHead(500);
        return res.end("Error loading page");
      }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(data);
    });
  } else {
    res.writeHead(404);
    res.end("Not found");
  }
});

const wss = new WebSocket.Server({ server });

wss.on("connection", (ws) => {
  ws.session = {
      clientId: null,
      userName: "Unknown User"
  };

  ws.on("message", async (data) => {
    let msgData;
    try {
        msgData = JSON.parse(data.toString());
    } catch (e) {
        console.error("Failed to parse incoming JSON:", data.toString());
        return;
    }
    
    // --- Handle Client Initialization (INIT) ---
    if (msgData.type === "init") {
        ws.session.clientId = msgData.clientId;
        ws.session.userName = msgData.name || "Unknown User";
        
        console.log(`User ${ws.session.userName} (${ws.session.clientId}) connected.`);
        
        // Send history
        const savedMessages = db.prepare("SELECT senderName, clientId, text FROM messages ORDER BY id ASC").all();
        
        savedMessages.forEach((msg) => {
            ws.send(JSON.stringify({
                type: "chat",
                sender: "user",
                senderName: msg.senderName,
                clientId: msg.clientId, 
                text: msg.text
            }));
        });
        
        // Broadcast welcome message to all connected clients
        const welcomeMsg = { sender: "system", text: `${ws.session.userName} has joined the chat!` };
        wss.clients.forEach((client) => {
          if (client.readyState === WebSocket.OPEN) {
             client.send(JSON.stringify(welcomeMsg));
          }
        });
        
        return; 
    }

    // --- Handle Chat Message (CHAT) ---
    if (msgData.type === "chat" && msgData.text.trim() !== "") {
        const text = msgData.text.trim();
        const { name, clientId } = msgData;
        
        // Construct the message object for saving/broadcasting
        const msg = {
          type: "chat",
          sender: "user",
          senderName: name, // Use the name provided by the client
          clientId: clientId, // Use the ID provided by the client
          text: text,
          timestamp: new Date().toISOString(),
        };

        // Save to DB
        db.prepare("INSERT INTO messages (sender, senderName, clientId, text, timestamp) VALUES (?, ?, ?, ?, ?)")
          .run(msg.sender, msg.senderName, msg.clientId, msg.text, msg.timestamp);

        // Broadcast to all clients
        wss.clients.forEach((client) => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(msg));
          }
        });
    }
  });

  // Handle client disconnection
  ws.on('close', () => {
    console.log(`User ${ws.session.userName} disconnected.`);
  });

});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
