const mongoose = require('mongoose');
const { proto } = require('@whiskeysockets/baileys');

const messageSchema = new mongoose.Schema({
    key: {
        remoteJid: {
            type: String,
            required: [true, 'remoteJid is missing'],
        },
        fromMe: {
            type: Boolean,
            default: false,
        },
        id: {
            type: String,
            required: [true, 'id is missing'],
            unique: true,
        },
        participant: {
            type: String,
            default: undefined,
        },
    },
    agentId: { type: mongoose.Schema.Types.Mixed },
    bizPrivacyStatus: { type: mongoose.Schema.Types.Mixed },
    broadcast: { type: mongoose.Schema.Types.Mixed },
    clearMedia: { type: mongoose.Schema.Types.Mixed },
    duration: { type: mongoose.Schema.Types.Mixed },
    ephemeralDuration: { type: mongoose.Schema.Types.Mixed },
    ephemeralOffToOn: { type: mongoose.Schema.Types.Mixed },
    ephemeralOutOfSync: { type: mongoose.Schema.Types.Mixed },
    ephemeralStartTimestamp: { type: mongoose.Schema.Types.Mixed },
    finalLiveLocation: { type: mongoose.Schema.Types.Mixed },
    futureproofData: { type: mongoose.Schema.Types.Mixed },
    ignore: { type: mongoose.Schema.Types.Mixed },
    keepInChat: { type: mongoose.Schema.Types.Mixed },
    labels: { type: mongoose.Schema.Types.Mixed },
    mediaCiphertextSha256: { type: mongoose.Schema.Types.Mixed },
    mediaData: { type: mongoose.Schema.Types.Mixed },
    message: { type: mongoose.Schema.Types.Mixed },
    messageC2STimestamp: { type: mongoose.Schema.Types.Mixed },
    messageSecret: { type: mongoose.Schema.Types.Mixed },
    messageStubParameters: { type: mongoose.Schema.Types.Mixed },
    messageStubType: { type: mongoose.Schema.Types.Mixed },
    messageTimestamp: { type: mongoose.Schema.Types.Mixed },
    multicast: { type: mongoose.Schema.Types.Mixed },
    originalSelfAuthorUserJidString: { type: mongoose.Schema.Types.Mixed },
    participant: { type: mongoose.Schema.Types.Mixed },
    paymentInfo: { type: mongoose.Schema.Types.Mixed },
    photoChange: { type: mongoose.Schema.Types.Mixed },
    pollAdditionalMetadata: { type: mongoose.Schema.Types.Mixed },
    pollUpdates: { type: mongoose.Schema.Types.Mixed },
    pushName: { type: mongoose.Schema.Types.Mixed },
    quotedPaymentInfo: { type: mongoose.Schema.Types.Mixed },
    quotedStickerData: { type: mongoose.Schema.Types.Mixed },
    reactions: { type: mongoose.Schema.Types.Mixed },
    revokeMessageTimestamp: { type: mongoose.Schema.Types.Mixed },
    starred: { type: mongoose.Schema.Types.Mixed },
    status: { type: mongoose.Schema.Types.Mixed },
    statusAlreadyViewed: { type: mongoose.Schema.Types.Mixed },
    statusPsa: { type: mongoose.Schema.Types.Mixed },
    urlNumber: { type: mongoose.Schema.Types.Mixed },
    urlText: { type: mongoose.Schema.Types.Mixed },
    userReceipt: { type: mongoose.Schema.Types.Mixed },
    verifiedBizName: { type: mongoose.Schema.Types.Mixed },
    });

const Message = mongoose.model('Message', messageSchema);

module.exports = Message;