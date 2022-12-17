/* eslint-disable no-unsafe-optional-chaining */
const QRCode = require('qrcode')
const pino = require('pino')
const {
    default: makeWASocket,
    DisconnectReason,
} = require('@adiwajshing/baileys')
const { unlinkSync } = require('fs')
const { v4: uuidv4 } = require('uuid')
const path = require('path')
const processButton = require('../helper/processbtn')
const generateVC = require('../helper/genVc')
const Chat = require('../models/chat.model')
const axios = require('axios')
const config = require('../../config/config')
const downloadMessage = require('../helper/downloadMsg')
const logger = require('pino')()
const useMongoDBAuthState = require('../helper/mongoAuthState')

class WhatsAppInstance {
    socketConfig = {
        defaultQueryTimeoutMs: undefined,
        printQRInTerminal: false,
        logger: pino({
            level: config.log.level,
        }),
        patchMessageBeforeSending: (message) => {
            const requiresPatch = !!(
                message.buttonsMessage ||
                // || message.templateMessage
                message.listMessage
            );
            if (requiresPatch) {
                message = {
                    viewOnceMessage: {
                        message: {
                            messageContextInfo: {
                                deviceListMetadataVersion: 2,
                                deviceListMetadata: {},
                            },
                            ...message,
                        },
                    },
                };
            }

            return message;
        },
    }
    key = ''
    authState
    allowWebhook = undefined
    webhook = undefined

    instance = {
        key: this.key,
        chats: [],
        qr: '',
        messages: [],
        qrRetry: 0,
        customWebhook: '',
    }

    axiosInstance = axios.create({
        baseURL: config.webhookUrl,
    })

    constructor(key, allowWebhook, webhook) {
        this.key = key ? key : uuidv4()
        this.instance.customWebhook = this.webhook ? this.webhook : webhook
        this.allowWebhook = config.webhookEnabled
            ? config.webhookEnabled
            : allowWebhook
        if (this.allowWebhook && this.instance.customWebhook !== null) {
            this.allowWebhook = true
            this.instance.customWebhook = webhook
            this.axiosInstance = axios.create({
                baseURL: webhook,
            })
        }
    }

    async SendWebhook(type, body) {
        if (!this.allowWebhook) return
        this.axiosInstance
            .post('', {
                type,
                body,
            })
            .catch(() => {})
    }

    async init() {
        this.collection = mongoClient.db('whatsapp-api').collection(this.key)
        const { state, saveCreds } = await useMongoDBAuthState(this.collection)
        this.authState = { state: state, saveCreds: saveCreds }
        this.socketConfig.auth = this.authState.state
        this.socketConfig.browser = Object.values(config.browser)
        this.instance.sock = makeWASocket(this.socketConfig)
        this.setHandler()
        return this
    }

    setHandler() {
        const sock = this.instance.sock
        // on credentials update save state
        sock?.ev.on('creds.update', this.authState.saveCreds)

        // on socket closed, opened, connecting
        sock?.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update

            if (connection === 'connecting') return

            if (connection === 'close') {
                // reconnect if not logged out
                if (
                    lastDisconnect?.error?.output?.statusCode !==
                    DisconnectReason.loggedOut
                ) {
                    await this.init()
                } else {
                    await this.collection.drop().then((r) => {
                        logger.info('STATE: Droped collection')
                    })
                    this.instance.online = false
                }

                await this.SendWebhook('connection', {
                    connection: connection,
                })
            } else if (connection === 'open') {
                if (config.mongoose.enabled) {
                    let alreadyThere = await Chat.findOne({
                        key: this.key,
                    }).exec()
                    if (!alreadyThere) {
                        const saveChat = new Chat({ key: this.key })
                        await saveChat.save()
                    }
                }
                this.instance.online = true

                await this.SendWebhook('connection', {
                    connection: connection,
                })
            }

            if (qr) {
                QRCode.toDataURL(qr).then((url) => {
                    this.instance.qr = url
                    this.instance.qrRetry++
                    if (this.instance.qrRetry >= config.instance.maxRetryQr) {
                        // close WebSocket connection
                        this.instance.sock.ws.close()
                        // remove all events
                        this.instance.sock.ev.removeAllListeners()
                        this.instance.qr = ' '
                        logger.info('socket connection terminated')
                    }
                })
            }
        })

        // sending presence
        sock?.ev.on('presence.update', async (json) => {
            await this.SendWebhook('presence', json)
        })

        // on receive all chats
        sock?.ev.on('chats.set', async ({ chats }) => {
            this.instance.chats = []
            const recivedChats = chats.map((chat) => {
                return {
                    ...chat,
                    messages: [],
                }
            })
            this.instance.chats.push(...recivedChats)
            await this.updateDb(this.instance.chats)
            await this.updateDbGroupsParticipants()
        })

        // on recive new chat
        sock?.ev.on('chats.upsert', (newChat) => {
            //console.log('chats.upsert')
            //console.log(newChat)
            const chats = newChat.map((chat) => {
                return {
                    ...chat,
                    messages: [],
                }
            })
            this.instance.chats.push(...chats)
        })

        // on chat change
        sock?.ev.on('chats.update', (changedChat) => {
            //console.log('chats.update')
            //console.log(changedChat)
            changedChat.map((chat) => {
                const index = this.instance.chats.findIndex(
                    (pc) => pc.id === chat.id
                )
                const PrevChat = this.instance.chats[index]
                this.instance.chats[index] = {
                    ...PrevChat,
                    ...chat,
                }
            })
        })

        // on chat delete
        sock?.ev.on('chats.delete', (deletedChats) => {
            //console.log('chats.delete')
            //console.log(deletedChats)
            deletedChats.map((chat) => {
                const index = this.instance.chats.findIndex(
                    (c) => c.id === chat
                )
                this.instance.chats.splice(index, 1)
            })
        })

        // on new mssage
        sock?.ev.on('messages.upsert', (m) => {
            //console.log('messages.upsert')
            //console.log(m)
            if (m.type === 'prepend')
                this.instance.messages.unshift(...m.messages)
            if (m.type !== 'notify') return

            this.instance.messages.unshift(...m.messages)

            m.messages.map(async (msg) => {
                if (!msg.message) return

                const messageType = Object.keys(msg.message)[0]
                if (
                    [
                        'protocolMessage',
                        'senderKeyDistributionMessage',
                    ].includes(messageType)
                )
                    return

                const webhookData = {
                    key: this.key,
                    ...msg,
                }

                if (messageType === 'conversation') {
                    webhookData['text'] = m
                }
                if (config.webhookBase64) {
                    switch (messageType) {
                        case 'imageMessage':
                            webhookData['msgContent'] = await downloadMessage(
                                msg.message.imageMessage,
                                'image'
                            )
                            break
                        case 'videoMessage':
                            webhookData['msgContent'] = await downloadMessage(
                                msg.message.videoMessage,
                                'video'
                            )
                            break
                        case 'audioMessage':
                            webhookData['msgContent'] = await downloadMessage(
                                msg.message.audioMessage,
                                'audio'
                            )
                            break
                        default:
                            webhookData['msgContent'] = ''
                            break
                    }
                }

                await this.SendWebhook('message', webhookData)
            })
        })

        sock?.ev.on('messages.update', async (messages) => {
            //console.log('messages.update')
            //console.dir(messages);
        })
        sock?.ws.on('CB:call', async (data) => {
            if (data.content) {
                if (data.content.find((e) => e.tag === 'offer')) {
                    const content = data.content.find((e) => e.tag === 'offer')

                    await this.SendWebhook('call_offer', {
                        id: content.attrs['call-id'],
                        timestamp: parseInt(data.attrs.t),
                        user: {
                            id: data.attrs.from,
                            platform: data.attrs.platform,
                            platform_version: data.attrs.version,
                        },
                    })
                } else if (data.content.find((e) => e.tag === 'terminate')) {
                    const content = data.content.find(
                        (e) => e.tag === 'terminate'
                    )

                    await this.SendWebhook('call_terminate', {
                        id: content.attrs['call-id'],
                        user: {
                            id: data.attrs.from,
                        },
                        timestamp: parseInt(data.attrs.t),
                        reason: data.content[0].attrs.reason,
                    })
                }
            }
        })

        sock?.ev.on('groups.upsert', async (newChat) => {
            //console.log('groups.upsert')
            //console.log(newChat)
            this.createGroupByApp(newChat)
            await this.SendWebhook('group_created', {
                data: newChat,
            })
        })

        sock?.ev.on('groups.update', async (newChat) => {
            //console.log('groups.update')
            //console.log(newChat)
            this.updateGroupSubjectByApp(newChat)
            await this.SendWebhook('group_updated', {
                data: newChat,
            })
        })

        sock?.ev.on('group-participants.update', async (newChat) => {
            //console.log('group-participants.update')
            //console.log(newChat)
            this.updateGroupParticipantsByApp(newChat)
            await this.SendWebhook('group_participants_updated', {
                data: newChat,
            })
        })
    }

    async getInstanceDetail(key) {
        return {
            instance_key: key,
            phone_connected: this.instance?.online,
            webhookUrl: this.instance.customWebhook,
            user: this.instance?.online ? this.instance.sock?.user : {},
        }
    }

    async getWhatsAppId(id) {
        if (id.includes('@g.us') || id.includes('@s.whatsapp.net')) return id
        if (id.includes('-')) return `${id}@g.us`
        const [result] = await this.instance.sock?.onWhatsApp(id)
        if (result?.exists) return result.jid
        throw new Error('no account exists')
    }

    /* async verifyId(id) {
        if (id.includes('@g.us')) return true
        const [result] = await this.instance.sock?.onWhatsApp(id)
        if (result?.exists) return true
        throw new Error('no account exists')
    } */

    async sendTextMessage(to, message) {
        const jid = await this.getWhatsAppId(to)
        const data = await this.instance.sock?.sendMessage(
            jid,
            { text: message }
        )
        return data
    }

    async sendMediaFile(to, file, type, caption = '', filename) {
        const jid = await this.getWhatsAppId(to)
        const data = await this.instance.sock?.sendMessage(
            jid,
            {
                mimetype: file.mimetype,
                [type]: file.buffer,
                caption: caption,
                ptt: type === 'audio' ? true : false,
                fileName: filename ? filename : file.originalname,
            }
        )
        return data
    }

    async sendUrlMediaFile(to, url, type, mimeType, caption = '') {
        const jid = await this.getWhatsAppId(to)

        const data = await this.instance.sock?.sendMessage(
            jid,
            {
                [type]: {
                    url: url,
                },
                caption: caption,
                mimetype: mimeType,
            }
        )
        return data
    }

    async DownloadProfile(of) {
        const jid = await this.getWhatsAppId(of)
        const ppUrl = await this.instance.sock?.profilePictureUrl(
            jid,
            'image'
        )
        return ppUrl
    }

    async getUserStatus(of) {
        const jid = await this.getWhatsAppId(of)
        const status = await this.instance.sock?.fetchStatus(
            jid
        )
        return status
    }

    async blockUnblock(to, data) {
        const jid = await this.getWhatsAppId(to)
        const status = await this.instance.sock?.updateBlockStatus(
            jid,
            data
        )
        return status
    }

    async sendButtonMessage(to, data) {
        const jid = await this.getWhatsAppId(to)
        const result = await this.instance.sock?.sendMessage(
            jid,
            {
                templateButtons: processButton(data.buttons),
                text: data.text ?? '',
                footer: data.footerText ?? '',
            }
        )
        return result
    }

    async sendContactMessage(to, data) {
        const jid = await this.getWhatsAppId(to)
        const vcard = generateVC(data)
        const result = await this.instance.sock?.sendMessage(
            jid,
            {
                contacts: {
                    displayName: data.fullName,
                    contacts: [{ displayName: data.fullName, vcard }],
                },
            }
        )
        return result
    }

    async sendListMessage(to, data) {
        const jid = await this.getWhatsAppId(to)
        const result = await this.instance.sock?.sendMessage(
            jid,
            {
                text: data.text,
                sections: data.sections,
                buttonText: data.buttonText,
                footer: data.description,
                title: data.title,
            }
        )
        return result
    }

    async sendMediaButtonMessage(to, data) {
        const jid = await this.getWhatsAppId(to)

        const result = await this.instance.sock?.sendMessage(
            jid,
            {
                [data.mediaType]: {
                    url: data.image,
                },
                footer: data.footerText ?? '',
                caption: data.text,
                templateButtons: processButton(data.buttons),
                mimetype: data.mimeType,
            }
        )
        return result
    }

    async setStatus(status, to) {
        const jid = await this.getWhatsAppId(to)

        const result = await this.instance.sock?.sendPresenceUpdate(status, jid)
        return result
    }

    // change your display picture or a group's
    async updateProfilePicture(id, url) {
        try {
            const jid = await this.getWhatsAppId(id)
            const img = await axios.get(url, { responseType: 'arraybuffer' })
            const res = await this.instance.sock?.updateProfilePicture(
                jid,
                img.data
            )
            return res
        } catch (e) {
            //console.log(e)
            return {
                error: true,
                message: 'Unable to update profile picture',
            }
        }
    }

    // get user or group object from db by id
    async getUserOrGroupById(id) {
        try {
            const jid = await this.getWhatsAppId(id)
            let Chats = await this.getChat()
            const group = Chats.find((c) => c.id === jid)
            if (!group)
                throw new Error(
                    'unable to get group, check if the group exists'
                )
            return group
        } catch (e) {
            logger.error(e)
            logger.error('Error get group failed')
        }
    }

    // Group Methods
    parseParticipants(users) {
        return users.map(async (users) => await this.getWhatsAppId(users))
    }

    async updateDbGroupsParticipants() {
        try {
            let groups = await this.groupFetchAllParticipating()
            let Chats = await this.getChat()
            if (groups && Chats) {
                for (const [key, value] of Object.entries(groups)) {
                    let group = Chats.find((c) => c.id === value.id)
                    if (group) {
                        let participants = []
                        for (const [
                            key_participant,
                            participant,
                        ] of Object.entries(value.participants)) {
                            participants.push(participant)
                        }
                        group.participant = participants
                        if (value.creation) {
                            group.creation = value.creation
                        }
                        if (value.subjectOwner) {
                            group.subjectOwner = value.subjectOwner
                        }
                        Chats.filter((c) => c.id === value.id)[0] = group
                    }
                }
                await this.updateDb(Chats)
            }
        } catch (e) {
            logger.error(e)
            logger.error('Error updating groups failed')
        }
    }

    async createNewGroup(name, users) {
        try {
            const group = await this.instance.sock?.groupCreate(
                name,
                users.map(this.getWhatsAppId)
            )
            return group
        } catch (e) {
            logger.error(e)
            logger.error('Error create new group failed')
        }
    }

    async addNewParticipant(id, users) {
        try {
            const jid = await this.getWhatsAppId(id)
            const res = await this.instance.sock?.groupAdd(
                jid,
                this.parseParticipants(users)
            )
            return res
        } catch {
            return {
                error: true,
                message:
                    'Unable to add participant, you must be an admin in this group',
            }
        }
    }

    async makeAdmin(id, users) {
        try {
            const jid = await this.getWhatsAppId(id)
            const res = await this.instance.sock?.groupMakeAdmin(
                jid,
                this.parseParticipants(users)
            )
            return res
        } catch {
            return {
                error: true,
                message:
                    'unable to promote some participants, check if you are admin in group or participants exists',
            }
        }
    }

    async demoteAdmin(id, users) {
        try {
            const jid = await this.getWhatsAppId(id)
            const res = await this.instance.sock?.groupDemoteAdmin(
                jid,
                this.parseParticipants(users)
            )
            return res
        } catch {
            return {
                error: true,
                message:
                    'unable to demote some participants, check if you are admin in group or participants exists',
            }
        }
    }

    async getAllGroups() {
        let Chats = await this.getChat()
        return Chats.filter((c) => c.id.includes('@g.us')).map((data, i) => {
            return {
                index: i,
                name: data.name,
                jid: data.id,
                participant: data.participant,
                creation: data.creation,
                subjectOwner: data.subjectOwner,
            }
        })
    }

    async leaveGroup(id) {
        try {
            const jid = await this.getWhatsAppId(id)
            let Chats = await this.getChat()
            const group = Chats.find((c) => c.id === jid)
            if (!group) throw new Error('no group exists')
            return await this.instance.sock?.groupLeave(jid)
        } catch (e) {
            logger.error(e)
            logger.error('Error leave group failed')
        }
    }

    async getInviteCodeGroup(id) {
        try {
            const jid = await this.getWhatsAppId(id)
            let Chats = await this.getChat()
            const group = Chats.find((c) => c.id === jid)
            if (!group)
                throw new Error(
                    'unable to get invite code, check if the group exists'
                )
            return await this.instance.sock?.groupInviteCode(jid)
        } catch (e) {
            logger.error(e)
            logger.error('Error get invite group failed')
        }
    }

    // get Chat object from db
    async getChat(key = this.key) {
        let dbResult = await Chat.findOne({ key: key }).exec()
        let ChatObj = dbResult.chat
        return ChatObj
    }

    // create new group by application
    async createGroupByApp(newChat) {
        try {
            let Chats = await this.getChat()
            let group = {
                id: newChat[0].id,
                name: newChat[0].subject,
                participant: newChat[0].participants,
                messages: [],
                creation: newChat[0].creation,
                subjectOwner: newChat[0].subjectOwner,
            }
            Chats.push(group)
            await this.updateDb(Chats)
        } catch (e) {
            logger.error(e)
            logger.error('Error updating document failed')
        }
    }

    async updateGroupSubjectByApp(newChat) {
        //console.log(newChat)
        try {
            if (newChat[0] && newChat[0].subject) {
                let Chats = await this.getChat()
                Chats.find((c) => c.id === newChat[0].id).name =
                    newChat[0].subject
                await this.updateDb(Chats)
            }
        } catch (e) {
            logger.error(e)
            logger.error('Error updating document failed')
        }
    }

    async updateGroupParticipantsByApp(newChat) {
        //console.log(newChat)
        try {
            if (newChat && newChat.id) {
                let Chats = await this.getChat()
                let chat = Chats.find((c) => c.id === newChat.id)
                let is_owner = false
                if (chat.participant == undefined) {
                    chat.participant = []
                }
                if (chat.participant && newChat.action == 'add') {
                    for (const participant of newChat.participants) {
                        chat.participant.push({ id: participant, admin: null })
                    }
                }
                if (chat.participant && newChat.action == 'remove') {
                    for (const participant of newChat.participants) {
                        // remove group if they are owner
                        if (chat.subjectOwner == participant) {
                            is_owner = true
                        }
                        chat.participant = chat.participant.filter(
                            (p) => p.id != participant
                        )
                    }
                }
                if (chat.participant && newChat.action == 'demote') {
                    for (const participant of newChat.participants) {
                        if (
                            chat.participant.filter(
                                (p) => p.id == participant
                            )[0]
                        ) {
                            chat.participant.filter(
                                (p) => p.id == participant
                            )[0].admin = null
                        }
                    }
                }
                if (chat.participant && newChat.action == 'promote') {
                    for (const participant of newChat.participants) {
                        if (
                            chat.participant.filter(
                                (p) => p.id == participant
                            )[0]
                        ) {
                            chat.participant.filter(
                                (p) => p.id == participant
                            )[0].admin = 'superadmin'
                        }
                    }
                }
                if (is_owner) {
                    Chats = Chats.filter((c) => c.id !== newChat.id)
                } else {
                    Chats.filter((c) => c.id === newChat.id)[0] = chat
                }
                await this.updateDb(Chats)
            }
        } catch (e) {
            logger.error(e)
            logger.error('Error updating document failed')
        }
    }

    async groupFetchAllParticipating() {
        try {
            const result =
                await this.instance.sock?.groupFetchAllParticipating()
            return result
        } catch (e) {
            logger.error('Error group fetch all participating failed')
        }
    }

    // update promote demote remove
    async groupParticipantsUpdate(id, users, action) {
        try {
            const jid = await this.getWhatsAppId(id)
            const res = await this.instance.sock?.groupParticipantsUpdate(
                jid,
                this.parseParticipants(users),
                action
            )
            return res
        } catch (e) {
            //console.log(e)
            return {
                error: true,
                message:
                    'unable to ' +
                    action +
                    ' some participants, check if you are admin in group or participants exists',
            }
        }
    }

    // update group settings like
    // only allow admins to send messages
    async groupSettingUpdate(id, action) {
        try {
            const jid = await this.getWhatsAppId(id)
            const res = await this.instance.sock?.groupSettingUpdate(
                jid,
                action
            )
            return res
        } catch (e) {
            //console.log(e)
            return {
                error: true,
                message:
                    'unable to ' + action + ' check if you are admin in group',
            }
        }
    }

    async groupUpdateSubject(id, subject) {
        try {
            const jid = await this.getWhatsAppId(id)
            const res = await this.instance.sock?.groupUpdateSubject(
                jid,
                subject
            )
            return res
        } catch (e) {
            //console.log(e)
            return {
                error: true,
                message:
                    'unable to update subject check if you are admin in group',
            }
        }
    }

    async groupUpdateDescription(id, description) {
        try {
            const jid = await this.getWhatsAppId(id)
            const res = await this.instance.sock?.groupUpdateDescription(
                jid,
                description
            )
            return res
        } catch (e) {
            //console.log(e)
            return {
                error: true,
                message:
                    'unable to update description check if you are admin in group',
            }
        }
    }

    // update db document -> chat
    async updateDb(object) {
        try {
            await Chat.updateOne({ key: this.key }, { chat: object })
        } catch (e) {
            logger.error('Error updating document failed')
        }
    }
}

exports.WhatsAppInstance = WhatsAppInstance
