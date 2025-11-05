const http = require("http");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");
const Database = require("better-sqlite3");

// --- Configuration ---
const MAX_CHAR_LIMIT = 500;
const ALLOWED_MIMES = [
    'image/gif', 
    'image/png', 
    'image/jpeg', 
    'video/mp4'
];

// Setup SQLite DB
const db = new Database("chat.db");

// Updated: Added fileUrl and fileType columns
db.prepare(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender TEXT,
    senderName TEXT, 
    clientId TEXT,     
    text TEXT,
    fileUrl TEXT,
    fileType TEXT,
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
    
    const { type, name, clientId } = msgData;

    // --- Handle Typing Signal ---
    if (type === "typing") {
        // Broadcast the typing status to everyone *except* the sender
        wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN && client !== ws) {
                client.send(JSON.stringify({
                    type: "typing",
                    isTyping: msgData.isTyping,
                    senderName: name, 
                    clientId: clientId
                }));
            }
        });
        return; 
    }

    // --- Handle Client Initialization (INIT) ---
    if (type === "init") {
        ws.session.clientId = clientId;
        ws.session.userName = name || "Unknown User";
        
        console.log(`User ${ws.session.userName} (${ws.session.clientId}) connected.`);
        
        // Send history (now includes fileUrl and fileType)
        const savedMessages = db.prepare("SELECT senderName, clientId, text, fileUrl, fileType FROM messages ORDER BY id ASC").all();
        
        savedMessages.forEach((msg) => {
            ws.send(JSON.stringify({
                type: "chat",
                sender: "user",
                senderName: msg.senderName,
                clientId: msg.clientId, 
                text: msg.text,
                fileUrl: msg.fileUrl,
                fileType: msg.fileType
            }));
        });
        
        // Broadcast welcome message
        const welcomeMsg = { sender: "system", text: `${ws.session.userName} has joined the chat!` };
        wss.clients.forEach((client) => {
          if (client.readyState === WebSocket.OPEN) {
             client.send(JSON.stringify(welcomeMsg));
          }
        });
        
        return; 
    }
    
    // --- Handle Chat or File Message ---
    if (type === "chat" || type === "file") {
        let text = (msgData.text || '').trim().substring(0, MAX_CHAR_LIMIT); // Enforce max length
        let fileUrl = null;
        let fileType = null;
        
        if (type === "file") {
            const base64Data = msgData.file;
            fileType = msgData.fileType;

            // 1. Server-side Validation
            if (!ALLOWED_MIMES.includes(fileType)) {
                 ws.send(JSON.stringify({ sender: "system", text: `Error: File type ${fileType} is not supported.` }));
                 return;
            }
            
            // 2. IMPORTANT: Due to the nature of Render's ephemeral filesystem, 
            //    we will store the file data directly as a Base64 Data URL 
            //    in the database instead of saving a file to disk.
            fileUrl = base64Data; // base64Data is already a full Data URL
        }

        // Must have either text OR a file
        if (!text && !fileUrl) return;

        // Construct the message object for saving/broadcasting
        const msg = {
          type: "chat",
          sender: "user",
          senderName: name, 
          clientId: clientId, 
          text: text,
          fileUrl: fileUrl,
          fileType: fileType,
          timestamp: new Date().toISOString(),
        };

        // Save to DB
        db.prepare("INSERT INTO messages (sender, senderName, clientId, text, fileUrl, fileType, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run(msg.sender, msg.senderName, msg.clientId, msg.text, msg.fileUrl, msg.fileType, msg.timestamp);

        // Broadcast to all clients
        wss.clients.forEach((client) => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(msg));
          }
        });
    }
  });

  ws.on('close', () => {
    console.log(`User ${ws.session.userName} disconnected.`);
    // Broadcast 'stopped typing' just in case
    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
                type: "typing",
                isTyping: false,
                senderName: ws.session.userName, 
                clientId: ws.session.clientId
            }));
        }
    });
  });

});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
