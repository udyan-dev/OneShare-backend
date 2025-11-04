/**
 * @fileoverview Defines the Mongoose data models for the ShareRoom collection.
 * This includes the main ShareRoom document and its nested FileMetadata sub-document.
 */

import { Schema, model } from 'mongoose';

/**
 * Defines the schema for a nested FileMetadata object.
 * This is a sub-document and will not have its own collection.
 * Setting `_id: false` optimizes storage by preventing Mongoose
 * from creating an ObjectId for this sub-document.
 */
const FileMetadataSchema = new Schema({
    originalName: { type: String, required: true },
    fileSize: { type: Number, required: true },
    mimeType: { type: String, required: true },
}, { _id: false });

/**
 * Defines the main schema for a ShareRoom document.
 * This document represents an active, shareable P2P session.
 */
const ShareRoomSchema = new Schema({
    /**
     * The human-readable, unique public ID for the room.
     * `unique: true` creates a database index to ensure uniqueness
     * and optimize read performance for 'join-room' operations.
     */
    shareId: {
        type: String,
        required: true,
        unique: true,
    },
    /**
     * The unique Socket.io ID of the room's creator (Sender).
     * `index: true` optimizes read performance for 'disconnect'
     * cleanup operations.
     */
    senderSocketId: {
        type: String,
        required: true,
        index: true,
    },
    /**
     * An array of Socket.io IDs for all connected Receivers.
     * This supports the 1-to-many broadcast model.
     */
    receiverSocketIds: {
        type: [String],
        required: true,
        default: [],
    },
    /**
     * An array of file metadata objects being shared in this room.
     * Enforces the `FileMetadataSchema`.
     */
    fileMetadata: {
        type: [FileMetadataSchema],
        required: true,
    },
    /**
     * A flag to indicate if the room is currently open to new receivers.
     * `default: true` ensures new rooms are "waiting" by default.
     */
    isWaiting: {
        type: Boolean,
        default: true,
    },
    /**
     * A unique, secret key for the Sender to perform manual
     * deletion/cancellation of the room.
     */
    deletionKey: {
        type: String,
        required: true,
        unique: true,
    },
    /**
     * A timestamp for when the document was created.
     * `default: Date.now` automatically sets this value on creation.
     */
    createdAt: {
        type: Date,
        default: Date.now,
    }
});

/**
 * Compiles the `ShareRoomSchema` into a Mongoose Model.
 * Mongoose will map this model to a collection named 'sharerooms' in MongoDB.
 */
const ShareRoom = model('ShareRoom', ShareRoomSchema);

/**
 * Exports the compiled ShareRoom model for use in other parts of the
 * application (e.g., the main server logic).
 */
export default ShareRoom;