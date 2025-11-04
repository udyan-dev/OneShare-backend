/**
 * @fileoverview The main entry point for the OneShareP2P signaling server.
 * This file initializes the Express server, Socket.io, connects to MongoDB,
 * and defines all real-time event handlers for the P2P handshake.
 */

// --- 1. IMPORTS ---
import * as dotenv from 'dotenv';
dotenv.config(); // Must run first to load environment variables

import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import mongoose from 'mongoose';
import { nanoid } from 'nanoid';
import ShareRoom from './models/ShareRoom.js'; // Note: .js extension is required for ES Modules in Node.js

// --- 2. INITIALIZATION ---

const app = express();
// Use the port defined by the host (e.g., Render) or default to 3000
const port = process.env.PORT || 3000;

// Create a native Node.js HTTP server, using the Express app as the handler.
// This is required to bind Socket.io to the same server.
const httpServer = http.createServer(app);

// Use a dynamic CORS origin for production, or allow all for development
const corsOrigin = process.env.NODE_ENV === 'production'
    ? process.env.CLIENT_URL
    : "*";

// Initialize the Socket.io Server and attach it to the HTTP server
const io = new Server(httpServer, {
    cors: {
        origin: corsOrigin,
    }
});

// --- 3. DATABASE CONNECTION ---

/**
 * Asynchronously connects to the MongoDB Atlas database using Mongoose.
 * Exits the process if the connection string is missing or if the
 * connection fails ("fail-fast" pattern).
 */
const connectDB = async () => {
    const uri = process.env.MONGODB_URI;

    if (!uri) {
        console.error("FATAL: MONGODB_URI is not defined in .env");
        process.exit(1);
    }
    try {
        await mongoose.connect(uri);
        console.log("MongoDB Atlas connected Successfully!");
    } catch (error) {
        console.error("MongoDB connection failed:", error);
        process.exit(1);
    }
};

// --- 4. EXPRESS API ROUTES ---

/**
 * A simple HTTP GET health check route.
 * Responds to requests at the root URL to verify the server is live.
 */
app.get('/', (req, res) => {
    res.send("Welcome to OneShare!");
});

// --- 5. SOCKET.IO REAL-TIME LOGIC ---

/**
 * The main connection handler. This block runs once for every
 * new client that establishes a WebSocket connection.
 * The 'socket' object represents the individual connection to that client.
 */
io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);

    /**
     * --- 5.1 CREATE ROOM (Sender's Logic) ---
     * Handles the 'create-room' event from a Sender.
     * Generates unique IDs, saves the new room to MongoDB,
     * joins the sender to the Socket.io room, and replies
     * with the new room's credentials.
     */
    socket.on('create-room', async (fileMetadata) => {
        try {
            // Runtime validation of the client's payload
            if (!fileMetadata || !Array.isArray(fileMetadata) || fileMetadata.length === 0) {
                socket.emit("create-room-error", "Invalid file metadata provided.");
                return;
            }

            const shareId = nanoid(6);
            const deletionKey = nanoid(10);

            // Create a new Mongoose document in memory
            const newRoom = new ShareRoom({
                shareId: shareId,
                senderSocketId: socket.id,
                deletionKey: deletionKey,
                fileMetadata: fileMetadata,
            });

            await newRoom.save(); // Asynchronously save to MongoDB
            socket.join(shareId); // Subscribe the sender to their own room (channel)

            console.log(`New room created: ${shareId}`);

            // Reply *only* to the sender with the new credentials
            socket.emit("room-created", {
                shareId: newRoom.shareId,
                deletionKey: newRoom.deletionKey
            });

        } catch (error) {
            console.error(`create-room error for socket ${socket.id}:`, error);
            socket.emit("create-room-error", "Failed to create room on server.");
        }
    });

    /**
     * --- 5.2 JOIN ROOM (Receiver's Logic) ---
     * Handles the 'join-room' event from a Receiver.
     * Validates the shareId, adds the receiver to the database
     * and Socket.io room, and then notifies all parties.
     */
    socket.on('join-room', async (shareId) => {
        try {
            // Find the room, ensuring it's still "waiting"
            const room = await ShareRoom.findOne({
                shareId: shareId,
                isWaiting: true,
            });

            // Guard clause: If no room is found, send an error and stop.
            if (!room) {
                socket.emit('join-room-error', 'Room not found or is no longer available!');
                return;
            }

            // 1. Add this Receiver to the Socket.io "room" (channel)
            socket.join(shareId);
            // 2. Add this Receiver's ID to the "guest list" in MongoDB
            await ShareRoom.updateOne(
                { shareId: shareId },
                { $push: { receiverSocketIds: socket.id } } // $push appends to an array
            );

            console.log(`Receiver ${socket.id} joined room ${shareId}`);

            // 3. Get a list of all other peers already in the room
            const allSocketIdsInRoom = await io.in(shareId).allSockets();
            const otherPeerSocketIds = Array.from(allSocketIdsInRoom)
                .filter(id => id !== socket.id); // All IDs *except* our own

            // 4. Reply *only* to the new Receiver
            socket.emit('join-success', {
                fileMetadata: room.fileMetadata,
                otherPeerSocketIds: otherPeerSocketIds // Send list of peers to connect to
            });

            // 5. Notify *all other* peers in the room that a new peer has joined
            socket.to(shareId).emit('new-peer-joined', {
                peerSocketId: socket.id
            });

        } catch (error) {
            console.error(`join-room error for socket ${socket.id}:`, error);
            socket.emit("join-room-error", "An internal server error occurred.");
        }
    });

    /**
     * --- 5.3 WEBRTC SIGNALING (RELAYS) ---
     * These handlers are simple, stateless relays. They forward
     * WebRTC handshake messages (offer, answer, candidate)
     * to the specified target socket ID.
     */

    socket.on('webrtc-offer', (data) => {
        if (!data.targetSocketId) return; // Safety check
        io.to(data.targetSocketId).emit("webrtc-offer-received", {
            offer: data.offer,
            senderSocketId: socket.id
        });
    });

    socket.on('webrtc-answer', (data) => {
        if (!data.targetSocketId) return;
        io.to(data.targetSocketId).emit("webrtc-answer-received", {
            answer: data.answer,
            senderSocketId: socket.id
        });
    });

    socket.on("webrtc-ice-candidate", (data) => {
        if (!data.targetSocketId) return;
        io.to(data.targetSocketId).emit("webrtc-ice-candidate-received", {
            candidate: data.candidate,
            senderSocketId: socket.id
        });
    });

    /**
     * --- 5.4 GRACEFUL DISCONNECT (CLEANUP) ---
     * This built-in event fires when a client connection is lost.
     * It handles cleaning up the database and notifying other peers.
     */
    socket.on('disconnect', async () => {
        console.log(`User disconnected: ${socket.id}`);
        try {
            // Case 1: Check if the disconnected user was a SENDER
            const roomAsSender = await ShareRoom.findOneAndDelete({
                senderSocketId: socket.id
            });

            if (roomAsSender) {
                // If they were a sender, the room is deleted.
                console.log(`Sender left, closing room: ${roomAsSender.shareId}`);
                // Notify all remaining receivers in that room.
                io.to(roomAsSender.shareId).emit("room-closed-by-sender");
            } else {
                // Case 2: The user was a RECEIVER
                // Notify all other peers that this user has left.
                socket.broadcast.emit('peer-left', {
                    peerSocketId: socket.id
                });

                // Remove the receiver's ID from any "guest list" they were on.
                await ShareRoom.updateMany(
                    { receiverSocketIds: socket.id },
                    { $pull: { receiverSocketIds: socket.id } }
                );
            }
        } catch (error) {
            console.error(`cleanup-room error for socket ${socket.id}:`, error);
        }
    });
});

// --- 6. START THE SERVER ---

/**
 * Best Practice: We only start listening for connections *after*
 * the database connection is successfully established.
 */
connectDB().then(() => {
    httpServer.listen(port, () => {
        console.log(`Server is running at http://localhost:${port}`);
    });
});