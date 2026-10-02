/**
 * A local, in-memory stand-in for the Telegram Bot API, for tests.
 *
 * Bot side: point a bot's Bot API base URL at this server and every call and
 * file download lands here. It answers like Telegram and keeps the state a
 * group bot works with: members and their status, profiles and photos,
 * messages (and which were deleted), invite links and pending join requests.
 *
 * Telegram side: tests drive it through /_fake/* (a user joins, asks to join,
 * leaves, posts text or a photo, presses a button, messages the bot). It sends
 * the webhook update Telegram would, with the registered secret token, and —
 * like Telegram — reports the bot's own restrictions back as chat_member
 * updates.
 *
 * More than one bot: the bot it starts with is the first; tests add others
 * (POST /_fake/bots). Each bot has its own webhook or update queue, and its
 * own membership and rights in each chat, and Telegram's rules about them
 * hold: a bot posts only where it is a member, edits and stops only its own
 * messages, pins only with the right to, and learns of its own membership
 * through my_chat_member. Tests can also make the next calls fail
 * (/_fake/failures), including a call that takes effect but never answers.
 *
 * Nothing here talks to Telegram.
 */
import { createOwnerModel, OwnerError } from "./owner.js";
import { formatText, FormattingError } from "./formatting.js";
import http from "node:http";
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
  timingSafeEqual,
} from "node:crypto";

// Every field of ChatPermissions, as of Bot API 10.3.
const PERMISSION_KEYS = Object.freeze([
  "can_send_messages",
  "can_send_audios",
  "can_send_documents",
  "can_send_photos",
  "can_send_videos",
  "can_send_video_notes",
  "can_send_voice_notes",
  "can_send_polls",
  "can_send_other_messages",
  "can_add_web_page_previews",
  "can_react_to_messages",
  "can_change_info",
  "can_invite_users",
  "can_pin_messages",
  "can_manage_topics",
  "can_edit_tag",
]);
const MEDIA_PERMISSIONS = Object.freeze([
  "can_send_messages",
  "can_send_audios",
  "can_send_documents",
  "can_send_photos",
  "can_send_videos",
  "can_send_video_notes",
  "can_send_voice_notes",
]);
const ALL_PERMISSIONS = Object.freeze(
  Object.fromEntries(PERMISSION_KEYS.map((key) => [key, true])),
);
const NO_GIFTS = Object.freeze({
  unlimited_gifts: false,
  limited_gifts: false,
  unique_gifts: false,
  premium_subscription: false,
  gifts_from_channels: false,
});

/**
 * A ChatPermissions object as Telegram applies it: unspecified fields are
 * false, and unless use_independent_chat_permissions is set, the broader
 * permissions imply the narrower ones.
 */
function normalizePermissions(input = {}, independent = false) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TelegramError(
      400,
      "Bad Request: can't parse permissions JSON object",
    );
  }
  const given = (key) => input[key] === true || input[key] === "true";
  const result = Object.fromEntries(
    PERMISSION_KEYS.map((key) => [key, given(key)]),
  );
  if (!(independent === true || independent === "true")) {
    if (result.can_send_other_messages || result.can_add_web_page_previews) {
      for (const key of MEDIA_PERMISSIONS) result[key] = true;
    }
    if (result.can_send_polls) result.can_send_messages = true;
  }
  if (!("can_react_to_messages" in input)) {
    result.can_react_to_messages = result.can_send_messages;
  }
  if (!("can_edit_tag" in input)) result.can_edit_tag = result.can_pin_messages;
  return result;
}
// How long a webhook may take to answer before the update is given up on.
const WEBHOOK_TIMEOUT_MS = 10_000;
const OBJECT_PARAMS = new Set([
  "allowed_updates",
  "permissions",
  "reply_markup",
  "message_ids",
  "link_preview_options",
  "reply_parameters",
  "commands",
  "media",
  "scope",
  "ephemeral_message_parameters",
  "options",
  "entities",
  "caption_entities",
  "reaction",
]);

// The administrator rights promoteChatMember sets.
const ADMIN_RIGHTS = Object.freeze([
  "is_anonymous",
  "can_manage_chat",
  "can_delete_messages",
  "can_manage_video_chats",
  "can_restrict_members",
  "can_promote_members",
  "can_change_info",
  "can_invite_users",
  "can_post_stories",
  "can_edit_stories",
  "can_delete_stories",
  "can_post_messages",
  "can_edit_messages",
  "can_pin_messages",
  "can_manage_topics",
]);

const CHAT_ACTIONS = new Set([
  "typing",
  "upload_photo",
  "record_video",
  "upload_video",
  "record_voice",
  "upload_voice",
  "upload_document",
  "choose_sticker",
  "find_location",
  "record_video_note",
  "upload_video_note",
]);

// sendDice emoji and the highest value each can roll.
const DICE = Object.freeze({
  "🎲": 6,
  "🎯": 6,
  "🎳": 6,
  "🏀": 5,
  "⚽": 5,
  "🎰": 64,
});

// What a member can post besides text and photos: the permission it needs,
// the file's folder and extension, and whether it takes a caption.
const MEMBER_MEDIA = Object.freeze({
  video: { permission: "can_send_videos", ext: "mp4", caption: true },
  animation: {
    permission: "can_send_other_messages",
    ext: "mp4",
    caption: true,
  },
  sticker: { permission: "can_send_other_messages", ext: "webp" },
  voice: { permission: "can_send_voice_notes", ext: "ogg", caption: true },
  audio: { permission: "can_send_audios", ext: "mp3", caption: true },
  video_note: { permission: "can_send_video_notes", ext: "mp4" },
  document: { permission: "can_send_documents", ext: "bin", caption: true },
});

// The media a message can carry, one at a time, and editMessageMedia replaces.
const MEDIA_KINDS = Object.freeze(["photo", "video", "animation", "document"]);

class TelegramError extends Error {
  constructor(code, description, parameters = null) {
    super(description);
    this.code = code;
    // The Bot API's ResponseParameters, when Telegram sends any.
    this.parameters = parameters;
  }
}

/** A request number, or the fallback when it is missing or not a number. */
function numberParam(value, fallback) {
  const number = Number(value);
  return value != null && value !== "" && Number.isFinite(number)
    ? number
    : fallback;
}

function now() {
  return Math.floor(Date.now() / 1000);
}

function fileUniqueId() {
  return `AgAD${randomBytes(6).toString("base64url")}`;
}

function userObject(user) {
  return {
    id: user.id,
    is_bot: user.is_bot === true,
    first_name: user.first_name,
    ...(user.last_name ? { last_name: user.last_name } : {}),
    ...(user.username ? { username: user.username } : {}),
    ...(user.language_code ? { language_code: user.language_code } : {}),
    ...(user.is_premium === true ? { is_premium: true } : {}),
  };
}

/**
 * The entities Telegram attaches to a member's text: bot commands, @mentions
 * and links, with UTF-16 offsets as Telegram reports them.
 */
function messageEntities(text) {
  const entities = [];
  const add = (type, offset, length) => entities.push({ type, offset, length });
  const overlaps = (offset, length) =>
    entities.some(
      (entity) =>
        offset < entity.offset + entity.length &&
        entity.offset < offset + length,
    );
  for (const match of text.matchAll(
    /(?<![\w@])\/[A-Za-z0-9_]+(?:@[A-Za-z0-9_]+)?/g,
  )) {
    if (match.index === 0) add("bot_command", match.index, match[0].length);
  }
  for (const match of text.matchAll(
    /(?<![\w.+-])[A-Za-z0-9._%+-]+@(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}\b/g,
  )) {
    add("email", match.index, match[0].length);
  }
  for (const match of text.matchAll(
    /(?<![\w@/])@[A-Za-z][A-Za-z0-9_]{3,31}\b/g,
  )) {
    if (!overlaps(match.index, match[0].length)) {
      add("mention", match.index, match[0].length);
    }
  }
  for (const match of text.matchAll(
    /\b(?:https?:\/\/[^\s]+|(?:t\.me|telegram\.me)\/[^\s]+|(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s]*)?)/gi,
  )) {
    // Sentence punctuation after a link is not part of it.
    const url = match[0].replace(/[.,!?;:)\]}'"]+$/, "");
    if (url && !overlaps(match.index, url.length)) {
      add("url", match.index, url.length);
    }
  }
  return entities.sort((left, right) => left.offset - right.offset);
}

function coerceParams(entries) {
  const params = {};
  for (const [key, value] of entries) {
    if (typeof value === "string" && OBJECT_PARAMS.has(key)) {
      try {
        params[key] = JSON.parse(value);
        continue;
      } catch {
        // keep the string
      }
    }
    params[key] = value;
  }
  return params;
}

/** Parse a JSON body that must be an object, or fail with a 400. */
function parseJsonObject(body) {
  let value;
  try {
    value = JSON.parse(body.toString("utf8"));
  } catch {
    throw new TelegramError(400, "Bad Request: request body is not valid JSON");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TelegramError(
      400,
      "Bad Request: request body must be a JSON object",
    );
  }
  return value;
}

async function readRequestParams(request, body) {
  const url = new URL(request.url, "http://localhost");
  const params = coerceParams(url.searchParams.entries());
  if (!body.length) return params;
  const type = String(request.headers["content-type"] ?? "");
  if (type.includes("application/json")) {
    return { ...params, ...parseJsonObject(body) };
  }
  if (
    !type.includes("multipart/form-data") &&
    !type.includes("application/x-www-form-urlencoded")
  ) {
    throw new TelegramError(
      400,
      "Bad Request: send parameters as a query string, JSON, or form data",
    );
  }
  let form;
  try {
    form = await new Request("http://localhost/", {
      method: "POST",
      headers: { "content-type": type },
      body,
    }).formData();
  } catch {
    throw new TelegramError(
      400,
      "Bad Request: request body is not valid form data",
    );
  }
  const entries = [];
  for (const [key, value] of form.entries()) {
    entries.push([
      key,
      typeof value === "string" ? value : await uploadedFile(value),
    ]);
  }
  return { ...params, ...coerceParams(entries) };
}

/** An uploaded part's bytes, carrying the file name and type it was sent with. */
async function uploadedFile(file) {
  const bytes = Buffer.from(await file.arrayBuffer());
  if (file.name) bytes.fileName = file.name;
  // A part's type may carry parameters ("text/plain;charset=utf-8"); Telegram
  // reports the bare media type.
  const type = file.type.split(";")[0].trim().toLowerCase();
  if (type && type !== "application/octet-stream") bytes.mimeType = type;
  return bytes;
}

const MIME_TYPES = {
  txt: "text/plain",
  csv: "text/csv",
  html: "text/html",
  md: "text/markdown",
  json: "application/json",
  pdf: "application/pdf",
  zip: "application/zip",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  mp4: "video/mp4",
};

function guessMimeType(fileName) {
  const extension = /\.([a-z0-9]+)$/i.exec(fileName ?? "")?.[1]?.toLowerCase();
  return extension ? MIME_TYPES[extension] : undefined;
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

/**
 * @param {{
 *   port?: number,
 *   host?: string,
 *   botToken: string,
 *   botUsername?: string,
 *   botName?: string,
 *   chats?: Array<{ id: number, title: string, ownerId: number, ownerName?: string }>,
 *   publicChats?: Array<{ username: string, type: "channel"|"supergroup"|"bot", title?: string }>,
 *   unimplemented?: "error" | "ok",
 *   log?: (line: string) => void,
 * }} options
 */
/** A PostedMessage as the control API takes it. */
function postedMessageBody(message) {
  return typeof message === "string"
    ? { text: message }
    : {
        ...(message.text !== undefined ? { text: message.text } : {}),
        ...(message.photo
          ? {
              photo_base64: Buffer.from(message.photo).toString("base64"),
            }
          : {}),
        ...(message.media
          ? {
              media: {
                type: message.media.type,
                base64: Buffer.from(message.media.bytes ?? []).toString(
                  "base64",
                ),
                ...(message.media.fileName
                  ? { file_name: message.media.fileName }
                  : {}),
                ...(message.media.mimeType
                  ? { mime_type: message.media.mimeType }
                  : {}),
              },
            }
          : {}),
        ...(message.forwardFrom
          ? {
              forward_from: {
                ...(message.forwardFrom.userId != null
                  ? { user_id: message.forwardFrom.userId }
                  : {}),
                ...(message.forwardFrom.chatId != null
                  ? { chat_id: message.forwardFrom.chatId }
                  : {}),
                ...(message.forwardFrom.messageId != null
                  ? { message_id: message.forwardFrom.messageId }
                  : {}),
                ...(message.forwardFrom.senderName
                  ? { sender_name: message.forwardFrom.senderName }
                  : {}),
              },
            }
          : {}),
        ...(message.caption ? { caption: message.caption } : {}),
        ...(message.replyTo != null ? { reply_to: message.replyTo } : {}),
        ...(message.threadId != null
          ? { message_thread_id: message.threadId }
          : {}),
      };
}

export async function startTestServer({
  port = 0,
  host = "127.0.0.1",
  botToken,
  botUsername = "fake_test_bot",
  botName = "Fake Test Bot",
  supportsJoinRequestQueries = false,
  chats: chatConfigs = [],
  publicChats = [],
  unimplemented: unimplementedMode = "error",
  loginClientSecret,
  log = () => {},
}) {
  if (unimplementedMode !== "error" && unimplementedMode !== "ok") {
    throw new TypeError('unimplemented must be "error" or "ok"');
  }
  const users = new Map();
  // Every bot this server answers for, by token. Each keeps its own webhook,
  // update queue and commands, as separate bots do on Telegram.
  const bots = new Map();
  function addBot({
    token,
    username,
    firstName,
    joinRequestQueries = false,
    loginClientSecret: secret,
  }) {
    const id = Number(String(token).split(":")[0]);
    if (!Number.isSafeInteger(id) || !String(token).includes(":")) {
      throw new TypeError(
        "Fake Telegram needs a bot token of the form <id>:<secret>",
      );
    }
    if (bots.has(token)) return bots.get(token);
    if (users.has(id)) throw new TypeError(`User ${id} already exists`);
    const record = {
      id,
      is_bot: true,
      first_name: firstName ?? username,
      username,
      photos: [],
      token,
      // The update types the bot subscribed to, set by setWebhook or getUpdates.
      webhook: null,
      subscription: null,
      // Updates waiting for getUpdates while no webhook is set, as on Telegram.
      queue: [],
      pollWaiters: new Set(),
      delivery: Promise.resolve(),
      commands: [],
      // A guard bot that gets join request queries (Bot API 10.x).
      joinRequestQueries: joinRequestQueries === true,
      // The Telegram Login client secret BotFather shows for the bot.
      loginClientSecret:
        typeof secret === "string" && secret !== ""
          ? secret
          : randomBytes(24).toString("base64url"),
    };
    bots.set(token, record);
    users.set(id, record);
    return record;
  }
  // The bot the server starts with: the one in every configured chat.
  const bot = addBot({
    token: botToken,
    username: botUsername,
    firstName: botName,
    joinRequestQueries: supportsJoinRequestQueries,
    loginClientSecret,
  });
  // Join request queries awaiting answerChatJoinRequestQuery, by query id.
  const joinQueries = new Map();
  const files = new Map();
  // Owner accounts: what a user sees on their own account (owner.js).
  const ownerModel = createOwnerModel({ log });
  const chats = new Map();
  // Public channels, groups and bots other accounts link to, by lower-case
  // username. A personal profile is never public: getChat on it fails.
  const publicByUsername = new Map();
  let nextPublicId = 1_000_000;
  for (const entry of publicChats) {
    const username = String(entry.username).replace(/^@/, "");
    nextPublicId += 1;
    publicByUsername.set(username.toLowerCase(), {
      id:
        entry.type === "bot"
          ? 6_000_000_000 + nextPublicId
          : -1_002_000_000_000 - nextPublicId,
      type: entry.type,
      username,
      title: entry.title ?? username,
    });
  }
  // A member's private chat with the bot, keyed by the member's id.
  const privateChats = new Map();
  // Business connections (Bot API 7.2+), by id: an account owner connects a
  // bot to answer their private chats.
  // https://core.telegram.org/bots/api#businessconnection
  const businessConnections = new Map();
  // Every update sent, by update_id, with the bot it went to and its exact
  // bytes, so a test can have Telegram deliver it again.
  const sentUpdates = new Map();
  const callbackAnswers = new Map();
  // Callback queries awaiting an answer; any other id is refused.
  const openQueries = new Set();
  const calls = [];
  const unimplemented = new Set();
  // Calls a test asked to fail: the next `times` calls of a method (to one
  // chat, from one bot, when named) answer the error, or take effect and never
  // answer.
  const failures = [];
  // Webhook requests in progress, aborted on stop().
  const inFlight = new Set();
  // Telegram never reuses an update, member or message id, and bots commonly
  // treat a repeated one as already handled; counters start from the clock so
  // a restarted fake does not repeat the previous run's ids.
  const startSeconds = Math.floor(Date.now() / 1000);
  let updateId = startSeconds;
  let nextUserId = 7_000_000_000 + startSeconds;
  let nextChatId = startSeconds;
  // Basic groups have their own ids: negative, without the -100 prefix.
  let nextBasicGroupId = 4_000_000_000 + (startSeconds % 100_000_000);
  let nextMediaGroupId = BigInt(startSeconds) * 1_000_000n;
  let nextPollId = BigInt(startSeconds) * 1_000_000n;

  for (const config of chatConfigs) {
    const owner = {
      id: config.ownerId,
      is_bot: false,
      first_name: config.ownerName ?? "Group Owner",
      bio: "",
      photos: [],
    };
    users.set(owner.id, owner);
    chats.set(config.id, {
      id: config.id,
      title: config.title,
      type: "supergroup",
      members: new Map([
        [owner.id, { status: "creator" }],
        [bot.id, { status: "administrator" }],
      ]),
      messages: new Map(),
      nextMessageId: startSeconds - 1_700_000_000,
      inviteLinks: new Map(),
      joinRequests: new Map(),
      permissions: { ...ALL_PERMISSIONS },
    });
  }

  function requireChat(chatId) {
    const chat = chats.get(Number(chatId));
    if (!chat) throw new TelegramError(400, "Bad Request: chat not found");
    return chat;
  }

  /** The group, or a member's private chat with the bot, holding a message. */
  function messageChat(chatId) {
    const id = Number(chatId);
    if (chats.has(id)) return chats.get(id);
    const user = users.get(id);
    if (!user || user.is_bot) {
      throw new TelegramError(400, "Bad Request: chat not found");
    }
    if (!privateChats.has(id)) {
      privateChats.set(id, {
        id,
        type: "private",
        user,
        messages: new Map(),
        nextMessageId: 1,
      });
    }
    return privateChats.get(id);
  }

  /**
   * The chat a Bot API call addresses. A bot cannot open a private chat: it
   * can only write to users who have messaged it first, as on Telegram.
   */
  function botChat(chatId) {
    const id = Number(chatId);
    if (chats.has(id)) return chats.get(id);
    if (privateChats.has(id)) return privateChats.get(id);
    const user = users.get(id);
    if (user && !user.is_bot) {
      throw new TelegramError(
        403,
        "Forbidden: bot can't initiate conversation with a user",
      );
    }
    throw new TelegramError(400, "Bad Request: chat not found");
  }

  function requireUser(userId) {
    const user = users.get(Number(userId));
    if (!user) throw new TelegramError(400, "Bad Request: user not found");
    return user;
  }

  function chatObject(chat) {
    if (chat.type === "private") {
      return {
        id: chat.id,
        type: "private",
        first_name: chat.user.first_name,
        ...(chat.user.last_name ? { last_name: chat.user.last_name } : {}),
        ...(chat.user.username ? { username: chat.user.username } : {}),
      };
    }
    return {
      id: chat.id,
      title: chat.title,
      type: chat.type,
      ...(chat.topics ? { is_forum: true } : {}),
    };
  }

  function memberStatus(chat, userId) {
    return chat.members.get(Number(userId)) ?? { status: "left" };
  }

  function chatMemberObject(chat, userId) {
    const user = requireUser(userId);
    const member = memberStatus(chat, userId);
    const base = { user: userObject(user), status: member.status };
    if (member.status === "administrator") {
      // A channel administrator posts and edits; a group administrator pins.
      const rights =
        chat.type === "channel"
          ? {
              can_manage_chat: true,
              can_delete_messages: true,
              can_restrict_members: true,
              can_promote_members: false,
              can_change_info: true,
              can_invite_users: true,
              can_post_messages: true,
              can_edit_messages: true,
              can_post_stories: false,
              can_edit_stories: false,
              can_delete_stories: false,
              can_manage_video_chats: false,
            }
          : {
              can_manage_chat: true,
              can_delete_messages: true,
              can_restrict_members: true,
              can_promote_members: false,
              can_change_info: true,
              can_invite_users: true,
              can_pin_messages: true,
              can_post_stories: false,
              can_edit_stories: false,
              can_delete_stories: false,
              can_manage_video_chats: false,
              can_manage_topics: false,
              can_send_welcome_messages: false,
            };
      return {
        ...base,
        // A bot can edit the administrators it promoted.
        can_be_edited: member.promotedBy != null,
        is_anonymous: false,
        ...rights,
        // Rights the owner granted or withheld when promoting.
        ...(member.rights ?? {}),
        ...(member.customTitle ? { custom_title: member.customTitle } : {}),
      };
    }
    if (member.status === "creator") return { ...base, is_anonymous: false };
    if (member.status === "restricted") {
      return {
        ...base,
        is_member: member.is_member !== false,
        until_date: member.until_date ?? 0,
        ...member.permissions,
      };
    }
    if (member.status === "kicked") {
      return { ...base, until_date: member.until_date ?? 0 };
    }
    return base;
  }

  function isInChat(chat, userId) {
    const member = memberStatus(chat, userId);
    return (
      ["member", "administrator", "creator"].includes(member.status) ||
      (member.status === "restricted" && member.is_member !== false)
    );
  }

  /** Whether a member holds an administrator right (a creator holds all). */
  function hasRight(chat, userId, right) {
    const member = memberStatus(chat, userId);
    if (member.status === "creator") return true;
    if (member.status !== "administrator") return false;
    return chatMemberObject(chat, userId)[right] === true;
  }

  function chatKind(chat) {
    return chat.type === "channel" || chat.type === "group"
      ? chat.type
      : "supergroup";
  }

  /** Refuse a bot's send the way Telegram does when it may not post there. */
  function requireCanSend(chat, caller) {
    // A private chat here is with the first bot: users write only to it, and
    // no other bot may message someone who never wrote to that bot.
    if (chat.type === "private") {
      // A business connection gives its bot the owner's private chat
      // (BusinessConnection.user_chat_id).
      if (caller.id !== bot.id && !chat.openTo?.has(caller.id)) {
        throw new TelegramError(
          403,
          "Forbidden: bot can't initiate conversation with a user",
        );
      }
      return;
    }
    const member = memberStatus(chat, caller.id);
    if (member.status === "kicked") {
      throw new TelegramError(
        403,
        `Forbidden: bot was kicked from the ${chatKind(chat)} chat`,
      );
    }
    if (!isInChat(chat, caller.id)) {
      throw new TelegramError(
        403,
        `Forbidden: bot is not a member of the ${chatKind(chat)} chat`,
      );
    }
    if (
      chat.type === "channel" &&
      !hasRight(chat, caller.id, "can_post_messages")
    ) {
      throw new TelegramError(
        400,
        "Bad Request: need administrator rights in the channel chat",
      );
    }
    if (
      member.status === "restricted" &&
      member.permissions?.can_send_messages !== true
    ) {
      throw new TelegramError(
        400,
        "Bad Request: not enough rights to send text messages to the chat",
      );
    }
  }

  /** A send into a forum names a topic that exists, or none (General). */
  function requireTopic(chat, threadId) {
    if (!threadId || !chat.topics) return;
    if (!chat.topics.has(Number(threadId))) {
      throw new TelegramError(400, "Bad Request: message thread not found");
    }
  }

  /** A group pins with can_pin_messages, a channel with can_edit_messages. */
  function requirePinRights(chat, caller) {
    if (chat.type === "private") return;
    if (!isInChat(chat, caller.id)) {
      throw new TelegramError(
        403,
        `Forbidden: bot is not a member of the ${chatKind(chat)} chat`,
      );
    }
    const right =
      chat.type === "channel" ? "can_edit_messages" : "can_pin_messages";
    if (!hasRight(chat, caller.id, right)) {
      throw new TelegramError(
        400,
        "Bad Request: not enough rights to manage pinned messages in the chat",
      );
    }
  }

  /** Whether the user may post, given their own and the chat's permissions. */
  function canPost(chat, userId, permission = "can_send_messages") {
    const member = memberStatus(chat, userId);
    if (!isInChat(chat, userId)) return false;
    if (["creator", "administrator"].includes(member.status)) return true;
    if (
      member.status === "restricted" &&
      member.permissions[permission] !== true
    ) {
      return false;
    }
    return chat.permissions[permission] === true;
  }

  /**
   * Telegram refuses to restrict or remove the chat owner, an administrator
   * or the bot itself.
   */
  function assertCanModerate(chat, userId, { self, caller = bot } = {}) {
    if (Number(userId) === caller.id && self) {
      throw new TelegramError(400, `Bad Request: ${self}`);
    }
    const status = memberStatus(chat, userId).status;
    if (status === "creator") {
      throw new TelegramError(400, "Bad Request: can't remove chat owner");
    }
    if (status === "administrator") {
      throw new TelegramError(
        400,
        "Bad Request: user is an administrator of the chat",
      );
    }
  }

  /**
   * Make the user a member again. A restriction outlives leaving and
   * rejoining on Telegram, so a restricted user comes back restricted.
   */
  function admit(chat, userId) {
    const current = memberStatus(chat, userId);
    chat.members.set(
      Number(userId),
      current.status === "restricted"
        ? { ...current, is_member: true }
        : { status: "member" },
    );
  }

  /** Send a chat_member update only when the member actually changed. */
  function memberChanged(chat, userId, before, actor, extra) {
    const after = chatMemberObject(chat, userId);
    if (JSON.stringify(before) === JSON.stringify(after))
      return Promise.resolve();
    return emitMemberChange(chat, userId, before, actor, extra);
  }

  function nextUpdateId() {
    updateId += 1;
    return updateId;
  }

  function allowed(record, type) {
    const list = record.subscription;
    if (!Array.isArray(list) || list.length === 0) {
      return ![
        "chat_member",
        "message_reaction",
        "message_reaction_count",
      ].includes(type);
    }
    return list.includes(type);
  }

  /**
   * Deliver an update to the bots that receive it: those in the group or
   * channel it happened in, the bot a private chat is with, or the bots named.
   */
  function emit(type, payload, { to = null, except = null } = {}) {
    const chatId = payload?.chat?.id ?? payload?.message?.chat?.id;
    const chat = chatId == null ? null : chats.get(Number(chatId));
    const recipients =
      to ??
      (chat
        ? [...bots.values()].filter(
            (record) => record.id !== except && isInChat(chat, record.id),
          )
        : [bot]);
    return Promise.all(
      recipients.map((record) => emitTo(record, type, payload)),
    );
  }

  /**
   * Deliver one update to one bot: to its webhook in order when one is set,
   * otherwise to the queue its getUpdates reads.
   */
  function emitTo(record, type, payload) {
    return emitOne(record, type, payload).delivered;
  }

  /** Send one update to one bot; says which update_id it got, if any. */
  function emitOne(record, type, payload) {
    if (!allowed(record, type)) {
      return { updateId: null, delivered: Promise.resolve() };
    }
    const update = { update_id: nextUpdateId(), [type]: payload };
    sentUpdates.set(update.update_id, {
      record,
      body: JSON.stringify(update),
    });
    if (!record.webhook?.url) {
      record.queue.push(structuredClone(update));
      wakePollers(record);
      return { updateId: update.update_id, delivered: Promise.resolve() };
    }
    return {
      updateId: update.update_id,
      delivered: deliver(record, update),
    };
  }

  function wakePollers(record) {
    for (const waiter of record.pollWaiters) waiter.wake();
  }

  function deliver(record, update, sentBody = null) {
    const type = Object.keys(update).find((key) => key !== "update_id");
    // Serialised now, so later state changes cannot rewrite a sent update.
    const body = sentBody ?? JSON.stringify(update);
    record.delivery = record.delivery.then(async () => {
      // The webhook may have been removed while this update waited its turn;
      // it then belongs to getUpdates, as on Telegram.
      const target = record.webhook;
      if (!target?.url) {
        record.queue.push(JSON.parse(body));
        wakePollers(record);
        return;
      }
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), WEBHOOK_TIMEOUT_MS);
      inFlight.add(abort);
      try {
        const response = await fetch(target.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(target.secret_token
              ? { "X-Telegram-Bot-Api-Secret-Token": target.secret_token }
              : {}),
          },
          body,
          signal: abort.signal,
        });
        await response.body?.cancel();
        if (!response.ok) {
          log(`webhook answered ${response.status} for ${type}`);
        }
      } catch (error) {
        log(`webhook delivery failed for ${type}: ${error.message}`);
      } finally {
        clearTimeout(timer);
        inFlight.delete(abort);
      }
    });
    return record.delivery;
  }

  function emitMemberChange(chat, userId, before, actor, extra = {}) {
    return emit(
      "chat_member",
      {
        chat: chatObject(chat),
        from: userObject(actor),
        date: now(),
        old_chat_member: before,
        new_chat_member: chatMemberObject(chat, userId),
        ...extra,
      },
      // A bot hears of its own membership through my_chat_member alone.
      { except: users.get(Number(userId))?.is_bot ? Number(userId) : null },
    );
  }

  /**
   * Someone adds, promotes, demotes or removes a bot. Telegram tells that bot
   * through my_chat_member, the chat's other bots through chat_member, and a
   * group's members through a service message.
   */
  async function setBotMembership(chat, record, { status, rights, actor }) {
    const before = chatMemberObject(chat, record.id);
    const wasIn = isInChat(chat, record.id);
    const botsBefore = botsIn(chat);
    if (status === "left") chat.members.delete(record.id);
    else chat.members.set(record.id, { status, ...(rights ? { rights } : {}) });
    const after = chatMemberObject(chat, record.id);
    const change = {
      chat: chatObject(chat),
      from: userObject(actor),
      date: now(),
      old_chat_member: before,
      new_chat_member: after,
    };
    await emitTo(record, "my_chat_member", change);
    await emit("chat_member", change, { except: record.id });
    const isIn = isInChat(chat, record.id);
    if (chat.type !== "channel" && wasIn !== isIn) {
      const service = addMessage(
        chat,
        actor,
        isIn
          ? { new_chat_members: [userObject(record)] }
          : { left_chat_member: userObject(record) },
      );
      // The bot itself gets it too: new_chat_members and left_chat_member
      // "may be the bot itself" (https://core.telegram.org/bots/api#message).
      await emit("message", service, {
        to: [...new Set([...botsBefore, ...botsIn(chat)])],
      });
    }
    return after;
  }

  /**
   * Whether a person may add members: the creator, an administrator with
   * can_invite_users, or a member when the chat's permissions allow it.
   */
  function canAddMembers(chat, userId) {
    const member = memberStatus(chat, userId);
    if (member.status === "creator") return true;
    if (member.status === "administrator") {
      return hasRight(chat, userId, "can_invite_users");
    }
    return canPost(chat, userId, "can_invite_users");
  }

  /** Whether a person may add or change administrators. */
  function canAddAdmins(chat, userId) {
    const member = memberStatus(chat, userId);
    return (
      member.status === "creator" ||
      (member.status === "administrator" &&
        hasRight(chat, userId, "can_promote_members"))
    );
  }

  /** Whether a person may change the chat's title or photo. */
  function canChangeInfo(chat, userId) {
    const member = memberStatus(chat, userId);
    if (member.status === "creator") return true;
    if (member.status === "administrator") {
      return hasRight(chat, userId, "can_change_info");
    }
    return canPost(chat, userId, "can_change_info");
  }

  /**
   * A person adds the bot through its t.me/<bot>?startgroup=<parameter> link
   * (https://core.telegram.org/api/links#group-channel-bot-links). With admin
   * rights requested, only someone who can add admins may; without, someone
   * who can add members. An existing administrator's rights are combined with
   * the requested ones. The link then invokes messages.startBot with the
   * parameter, which posts "/start@<bot> <parameter>" from the person
   * (https://core.telegram.org/bots/features#deep-linking).
   */
  async function addBotViaLink(chat, record, { by, startParameter, rights }) {
    const actor = requireUser(by ?? creatorOf(chat));
    const asAdmin = rights != null;
    if (
      asAdmin ? !canAddAdmins(chat, actor.id) : !canAddMembers(chat, actor.id)
    ) {
      throw new TelegramError(400, "CHAT_ADMIN_REQUIRED");
    }
    const current = memberStatus(chat, record.id);
    if (asAdmin) {
      const existing =
        current.status === "administrator"
          ? chatMemberObject(chat, record.id)
          : {};
      const combined = {};
      for (const [right, value] of Object.entries(rights)) {
        combined[right] = value === true || existing[right] === true;
      }
      for (const [right, value] of Object.entries(existing)) {
        if (right.startsWith("can_") && value === true) combined[right] = true;
      }
      await setBotMembership(chat, record, {
        status: "administrator",
        rights: combined,
        actor,
      });
    } else if (!isInChat(chat, record.id)) {
      await setBotMembership(chat, record, { status: "member", actor });
    }
    const text =
      `/start@${record.username}` +
      (startParameter ? ` ${String(startParameter)}` : "");
    const message = addMessage(chat, actor, { text });
    const entities = messageEntities(text);
    if (entities.length > 0) message.entities = entities;
    await emit("message", message);
    return chatMemberObject(chat, record.id);
  }

  /**
   * The creator or an administrator upgrades a basic group to a supergroup
   * (https://core.telegram.org/api/channel#migration): a new supergroup takes
   * its members, administrators and bots; the old chat says where it went
   * (migrate_to_chat_id) and the new one where it came from
   * (migrate_from_chat_id).
   */
  async function migrateToSupergroup(chat, { by }) {
    if (chat.type !== "group") {
      throw new TelegramError(400, "only a basic group can be upgraded");
    }
    if (chat.migratedTo != null) {
      throw new TelegramError(400, "the group was already upgraded");
    }
    const actor = requireUser(by ?? creatorOf(chat));
    if (
      !["creator", "administrator"].includes(
        memberStatus(chat, actor.id).status,
      )
    ) {
      throw new TelegramError(400, "CHAT_ADMIN_REQUIRED");
    }
    nextChatId += 1;
    const supergroup = {
      ...chat,
      id: -(1_000_000_000_000 + nextChatId),
      type: "supergroup",
      members: new Map(
        [...chat.members].map(([id, member]) => [id, structuredClone(member)]),
      ),
      messages: new Map(),
      inviteLinks: new Map(),
      joinRequests: new Map(),
      pinned: [],
      migratedFrom: chat.id,
    };
    delete supergroup.migratedTo;
    chats.set(supergroup.id, supergroup);
    chat.migratedTo = supergroup.id;
    await emit(
      "message",
      addMessage(chat, actor, { migrate_to_chat_id: supergroup.id }),
    );
    await emit(
      "message",
      addMessage(supergroup, actor, { migrate_from_chat_id: chat.id }),
    );
    return chatObject(supergroup);
  }

  /** A person renames the chat; bots get the new_chat_title service message. */
  async function renameByPerson(chat, { by, title }) {
    const actor = requireUser(by ?? creatorOf(chat));
    if (!canChangeInfo(chat, actor.id)) {
      throw new TelegramError(400, "CHAT_ADMIN_REQUIRED");
    }
    const name = String(title ?? "").trim();
    if (!name || name.length > 128) {
      throw new TelegramError(400, "CHAT_TITLE_EMPTY");
    }
    if (name === chat.title) throw new TelegramError(400, "CHAT_NOT_MODIFIED");
    chat.title = name;
    const message = addMessage(chat, actor, { new_chat_title: name });
    await emit("message", message);
    return { message_id: message.message_id };
  }

  /** A person sets the chat photo; bots get the new_chat_photo service message. */
  async function changePhotoByPerson(chat, { by, base64 }) {
    const actor = requireUser(by ?? creatorOf(chat));
    if (!canChangeInfo(chat, actor.id)) {
      throw new TelegramError(400, "CHAT_ADMIN_REQUIRED");
    }
    const bytes = Buffer.from(String(base64 ?? ""), "base64");
    if (bytes.length === 0) throw new TelegramError(400, "PHOTO_INVALID");
    chat.photo = registerPhoto(bytes);
    const message = addMessage(chat, actor, {
      new_chat_photo: photoSizes(chat.photo),
    });
    await emit("message", message);
    return { message_id: message.message_id };
  }

  /** The bots that are members of a chat. */
  function botsIn(chat) {
    return [...bots.values()].filter((record) => isInChat(chat, record.id));
  }

  function requireBot(botId) {
    const record = [...bots.values()].find(
      (entry) => entry.id === Number(botId),
    );
    if (!record) throw new TelegramError(400, "Bad Request: bot not found");
    return record;
  }

  function addMessage(chat, from, fields) {
    const message = {
      message_id: chat.nextMessageId++,
      from: userObject(from),
      chat: chatObject(chat),
      date: now(),
      ...fields,
    };
    chat.messages.set(message.message_id, { message, deleted: false });
    return message;
  }

  // Image bytes only. Accepting a file path here would let anyone who can reach
  // the control API read any file on the host through the file download URL.
  function registerFile(bytes, folder, extension) {
    const data = bytes;
    const fileId = `AgACAgQAAx0Cfake${randomBytes(9).toString("base64url")}`;
    const uniqueId = fileUniqueId();
    const fileName = bytes.fileName;
    const mimeType =
      bytes.mimeType ?? (fileName ? guessMimeType(fileName) : undefined);
    files.set(fileId, {
      data,
      file_unique_id: uniqueId,
      file_path: `${folder}/${fileId}.${extension}`,
      ...(fileName ? { file_name: fileName } : {}),
      ...(mimeType ? { mime_type: mimeType } : {}),
    });
    return {
      file_id: fileId,
      file_unique_id: uniqueId,
      size: data.length,
      ...(fileName ? { file_name: fileName } : {}),
      ...(mimeType ? { mime_type: mimeType } : {}),
    };
  }

  function registerPhoto(bytes) {
    return registerFile(bytes, "photos", "jpg");
  }

  /**
   * The file a send* call refers to: an uploaded file, or the file_id of one
   * this server already holds. Anything else becomes a one-byte placeholder.
   */
  function sentFile(value, folder, extension) {
    if (typeof value === "string" && files.has(value)) {
      const file = files.get(value);
      return {
        file_id: value,
        file_unique_id: file.file_unique_id,
        size: file.data.length,
        ...(file.file_name ? { file_name: file.file_name } : {}),
        ...(file.mime_type ? { mime_type: file.mime_type } : {}),
      };
    }
    return registerFile(
      Buffer.isBuffer(value) ? value : Buffer.alloc(1),
      folder,
      extension,
    );
  }

  /** The Message field for a stored file of a media type, as the Bot API has it. */
  function mediaField(type, file, { fileName, mimeType, duration = 1 } = {}) {
    const base = {
      file_id: file.file_id,
      file_unique_id: file.file_unique_id,
      file_size: file.size,
    };
    switch (type) {
      case "photo":
        return photoSizes(file);
      case "video":
      case "animation":
        return {
          ...base,
          width: 1280,
          height: 720,
          duration,
          mime_type: mimeType ?? "video/mp4",
          ...(fileName ? { file_name: fileName } : {}),
        };
      case "sticker":
        return {
          ...base,
          type: "regular",
          width: 512,
          height: 512,
          is_animated: false,
          is_video: false,
        };
      case "voice":
        return { ...base, duration, mime_type: mimeType ?? "audio/ogg" };
      case "audio":
        return {
          ...base,
          duration,
          mime_type: mimeType ?? "audio/mpeg",
          ...(fileName ? { file_name: fileName } : {}),
        };
      case "video_note":
        return { ...base, length: 240, duration };
      default:
        return {
          ...base,
          file_name: fileName ?? "file",
          mime_type: mimeType ?? "application/octet-stream",
        };
    }
  }

  /** Message fields for one piece of media; an animation is also a document. */
  function mediaFields(type, file, options) {
    const fields = { [type]: mediaField(type, file, options) };
    if (type === "animation") {
      fields.document = mediaField("document", file, {
        fileName: options?.fileName ?? "animation.mp4",
        mimeType: "video/mp4",
      });
    }
    return fields;
  }

  function photoSizes(photo) {
    return [
      {
        file_id: photo.file_id,
        file_unique_id: photo.file_unique_id,
        width: 800,
        height: 800,
        file_size: photo.size,
      },
    ];
  }

  // ── Bot API ────────────────────────────────────────────────────────────
  // Each method runs as the bot whose token the request carried.
  const methods = {
    getMe: (_p, caller) => ({
      ...userObject(caller),
      can_join_groups: true,
      can_read_all_group_messages: true,
      supports_inline_queries: false,
      supports_join_request_queries: caller.joinRequestQueries,
      // Every bot here can be connected to a business account.
      can_connect_to_business: true,
    }),
    setWebhook: (p, caller) => {
      if (!p.url) {
        caller.webhook = null;
        return true;
      }
      caller.webhook = {
        url: String(p.url),
        secret_token: p.secret_token ?? null,
      };
      if (Array.isArray(p.allowed_updates)) {
        caller.subscription = p.allowed_updates;
      }
      // Updates that queued while nobody was listening go to the new webhook.
      const pending = isTrue(p.drop_pending_updates)
        ? []
        : caller.queue.splice(0);
      caller.queue.length = 0;
      for (const update of pending) deliver(caller, update);
      return true;
    },
    deleteWebhook: (p, caller) => {
      caller.webhook = null;
      if (isTrue(p.drop_pending_updates)) caller.queue.length = 0;
      return true;
    },
    getWebhookInfo: (_p, caller) => ({
      url: caller.webhook?.url ?? "",
      has_custom_certificate: false,
      pending_update_count: caller.webhook?.url ? 0 : caller.queue.length,
      ...(caller.subscription ? { allowed_updates: caller.subscription } : {}),
    }),
    getUpdates: async (p, caller) => {
      const queue = caller.queue;
      if (caller.webhook?.url) {
        throw new TelegramError(
          409,
          "Conflict: can't use getUpdates method while webhook is active; use deleteWebhook to delete the webhook first",
        );
      }
      if (Array.isArray(p.allowed_updates)) {
        caller.subscription = p.allowed_updates;
      }
      const offset = numberParam(p.offset, 0);
      // An offset confirms every update before it: they are gone for good.
      if (offset > 0) {
        while (queue.length && queue[0].update_id < offset) queue.shift();
      } else if (offset < 0) {
        queue.splice(0, Math.max(0, queue.length + offset));
      }
      const limit = Math.min(100, Math.max(1, numberParam(p.limit, 100)));
      const timeoutMs = Math.max(0, numberParam(p.timeout, 0)) * 1000;
      if (queue.length === 0 && timeoutMs > 0) {
        await new Promise((resolve) => {
          const waiter = {
            wake: () => {
              clearTimeout(waiter.timer);
              caller.pollWaiters.delete(waiter);
              resolve();
            },
          };
          waiter.timer = setTimeout(waiter.wake, timeoutMs);
          caller.pollWaiters.add(waiter);
        });
      }
      return queue.slice(0, limit);
    },
    setMyCommands: (p, caller) => {
      caller.commands = Array.isArray(p.commands) ? p.commands : [];
      return true;
    },
    deleteMyCommands: (_p, caller) => {
      caller.commands = [];
      return true;
    },
    getMyCommands: (_p, caller) => caller.commands,
    setMyDescription: () => true,
    setMyShortDescription: () => true,
    setChatMenuButton: () => true,
    setMyDefaultAdministratorRights: () => true,
    answerCallbackQuery: (p) => {
      if (!openQueries.delete(String(p.callback_query_id))) {
        throw new TelegramError(
          400,
          "Bad Request: query is too old and response timeout expired or query ID is invalid",
        );
      }
      callbackAnswers.set(String(p.callback_query_id), {
        text: p.text ?? "",
        show_alert: String(p.show_alert) === "true",
      });
      return true;
    },
    getChat: (p) => {
      if (String(p.chat_id).startsWith("@")) {
        const entry = publicByUsername.get(
          String(p.chat_id).slice(1).toLowerCase(),
        );
        if (!entry) throw new TelegramError(400, "Bad Request: chat not found");
        const common = {
          accent_color_id: 0,
          max_reaction_count: 11,
          accepted_gift_types: { ...NO_GIFTS },
        };
        return entry.type === "bot"
          ? {
              id: entry.id,
              type: "private",
              first_name: entry.title,
              username: entry.username,
              ...common,
            }
          : {
              id: entry.id,
              type: entry.type,
              title: entry.title,
              username: entry.username,
              ...common,
            };
      }
      const id = Number(p.chat_id);
      if (chats.has(id)) {
        const chat = chats.get(id);
        const pinned = chat.messages.get((chat.pinned ?? [])[0]);
        return {
          ...chatObject(chat),
          ...(pinned && !pinned.deleted
            ? { pinned_message: pinned.message }
            : {}),
          permissions: { ...chat.permissions },
          ...(chat.description ? { description: chat.description } : {}),
          ...(chat.photo
            ? {
                photo: {
                  small_file_id: chat.photo.file_id,
                  small_file_unique_id: chat.photo.file_unique_id,
                  big_file_id: chat.photo.file_id,
                  big_file_unique_id: chat.photo.file_unique_id,
                },
              }
            : {}),
          accent_color_id: 0,
          max_reaction_count: 11,
          accepted_gift_types: { ...NO_GIFTS },
        };
      }
      // A user the bot shares a group with; the bio shows as under
      // Telegram's default privacy (everybody).
      const user = users.get(id);
      if (!user) throw new TelegramError(400, "Bad Request: chat not found");
      const photo = user.photos?.[0];
      return {
        id: user.id,
        type: "private",
        first_name: user.first_name,
        ...(user.last_name ? { last_name: user.last_name } : {}),
        ...(user.username ? { username: user.username } : {}),
        ...(user.bio ? { bio: user.bio } : {}),
        ...(photo
          ? {
              photo: {
                small_file_id: photo.file_id,
                small_file_unique_id: photo.file_unique_id,
                big_file_id: photo.file_id,
                big_file_unique_id: photo.file_unique_id,
              },
            }
          : {}),
        accent_color_id: 0,
        max_reaction_count: 11,
        accepted_gift_types: { ...NO_GIFTS },
      };
    },
    getChatMember: (p) => chatMemberObject(requireChat(p.chat_id), p.user_id),
    getChatAdministrators: (p) => {
      const chat = requireChat(p.chat_id);
      return [...chat.members.entries()]
        .filter(([, m]) => ["creator", "administrator"].includes(m.status))
        .map(([id]) => chatMemberObject(chat, id));
    },
    getChatMemberCount: (p) => {
      const chat = requireChat(p.chat_id);
      return [...chat.members.keys()].filter((id) => isInChat(chat, id)).length;
    },
    getUserProfilePhotos: (p) => {
      const user = requireUser(p.user_id);
      const offset = Math.max(0, numberParam(p.offset, 0));
      const limit = Math.min(100, Math.max(1, numberParam(p.limit, 100)));
      const photos = (user.photos ?? []).slice(offset, offset + limit);
      return {
        total_count: user.photos?.length ?? 0,
        photos: photos.map(photoSizes),
      };
    },
    getFile: (p) => {
      const file = files.get(String(p.file_id));
      if (!file) throw new TelegramError(400, "Bad Request: invalid file_id");
      return {
        file_id: p.file_id,
        file_unique_id: file.file_unique_id,
        file_size: file.data.length,
        file_path: file.file_path,
      };
    },
    sendMessage: (p, caller) =>
      p.business_connection_id
        ? sendBusinessMessage(p, caller)
        : sendFrom(p, caller, textFields(p)),
    getBusinessConnection: (p, caller) =>
      businessConnectionObject(
        requireBusinessConnection(p.business_connection_id, caller),
      ),
    sendPhoto: async (p, caller) => {
      const photo =
        typeof p.photo === "string" && files.has(p.photo)
          ? {
              file_id: p.photo,
              ...files.get(p.photo),
              size: files.get(p.photo).data.length,
            }
          : sentFile(p.photo, "photos", "jpg");
      return sendFrom(p, caller, {
        photo: photoSizes(photo),
        ...captionFields(p),
      });
    },
    sendDocument: (p, caller) => {
      const file = sentFile(p.document, "documents", "bin");
      return sendFrom(p, caller, {
        document: {
          file_id: file.file_id,
          file_unique_id: file.file_unique_id,
          file_size: file.size,
          file_name: file.file_name ?? "document",
          mime_type: file.mime_type ?? "application/octet-stream",
        },
        ...captionFields(p),
      });
    },
    sendVideo: (p, caller) => {
      const file = sentFile(p.video, "videos", "mp4");
      return sendFrom(p, caller, {
        video: {
          file_id: file.file_id,
          file_unique_id: file.file_unique_id,
          width: 640,
          height: 360,
          duration: 1,
          file_size: file.size,
        },
        ...captionFields(p),
      });
    },
    sendAnimation: (p, caller) => {
      const file = sentFile(p.animation, "animations", "mp4");
      return sendFrom(p, caller, {
        animation: {
          file_id: file.file_id,
          file_unique_id: file.file_unique_id,
          width: 320,
          height: 240,
          duration: 1,
          file_size: file.size,
        },
        ...captionFields(p),
      });
    },
    sendSticker: (p, caller) => {
      const file = sentFile(p.sticker, "stickers", "webp");
      return sendFrom(p, caller, {
        sticker: {
          file_id: file.file_id,
          file_unique_id: file.file_unique_id,
          type: "regular",
          width: 512,
          height: 512,
          is_animated: false,
          is_video: false,
          file_size: file.size,
        },
      });
    },
    editMessageText: (p, caller) => {
      const formatted = textFields(p);
      return editMessage(p, caller, (message) => {
        message.text = formatted.text;
        if (formatted.entities) message.entities = formatted.entities;
        else delete message.entities;
      });
    },
    editMessageReplyMarkup: (p, caller) => editMessage(p, caller, () => {}),
    editMessageCaption: (p, caller) => {
      const formatted = captionFields(p);
      return editMessage(p, caller, (message) => {
        message.caption = formatted.caption ?? "";
        if (formatted.caption_entities) {
          message.caption_entities = formatted.caption_entities;
        } else delete message.caption_entities;
      });
    },
    // The new media is an upload attached as attach://<name>, or the file_id
    // of a file this server holds.
    editMessageMedia: (p, caller) => {
      const input = p.media ?? {};
      const type = input.type ?? "photo";
      if (!MEDIA_KINDS.includes(type)) {
        throw new TelegramError(400, "Bad Request: unsupported media type");
      }
      const reference =
        typeof input.media === "string" && input.media.startsWith("attach://")
          ? p[input.media.slice("attach://".length)]
          : input.media;
      if (
        !Buffer.isBuffer(reference) &&
        !(typeof reference === "string" && files.has(reference))
      ) {
        throw new TelegramError(
          400,
          "Bad Request: wrong file identifier/HTTP URL specified",
        );
      }
      const file = sentFile(
        reference,
        `${type}s`,
        type === "photo" ? "jpg" : "bin",
      );
      return editMessage(p, caller, (message) => {
        delete message.text;
        delete message.entities;
        for (const kind of MEDIA_KINDS) delete message[kind];
        message[type] =
          type === "photo"
            ? photoSizes(file)
            : {
                file_id: file.file_id,
                file_unique_id: file.file_unique_id,
                file_size: file.size,
              };
        if (input.caption !== undefined) {
          message.caption = String(input.caption);
        } else {
          delete message.caption;
        }
      });
    },
    // A poll may carry a photo, uploaded with it as attach://<name>.
    sendPoll: (p, caller) => {
      const options = (Array.isArray(p.options) ? p.options : []).map(
        (option) => ({
          text:
            typeof option === "string" ? option : String(option?.text ?? ""),
          voter_count: 0,
        }),
      );
      if (!p.question) {
        throw new TelegramError(
          400,
          "Bad Request: poll question must be non-empty",
        );
      }
      if (options.length < 2) {
        throw new TelegramError(
          400,
          "Bad Request: poll must have at least 2 option",
        );
      }
      if (options.length > 12) {
        throw new TelegramError(
          400,
          "Bad Request: poll can't have more than 12 options",
        );
      }
      const attached =
        typeof p.media?.media === "string" &&
        p.media.media.startsWith("attach://")
          ? p[p.media.media.slice("attach://".length)]
          : null;
      const photo = Buffer.isBuffer(attached) ? registerPhoto(attached) : null;
      nextPollId += 1n;
      return sendFrom(p, caller, {
        poll: {
          id: String(nextPollId),
          question: String(p.question),
          options,
          total_voter_count: 0,
          is_closed: false,
          is_anonymous: String(p.is_anonymous ?? "true") !== "false",
          type: p.type === "quiz" ? "quiz" : "regular",
          allows_multiple_answers: isTrue(p.allows_multiple_answers),
          ...(p.description ? { description: String(p.description) } : {}),
          ...(photo ? { media: { photo: photoSizes(photo) } } : {}),
        },
      });
    },
    stopPoll: (p, caller) => {
      const chat = botChat(p.chat_id);
      const entry = chat.messages.get(Number(p.message_id));
      if (!entry || entry.deleted || !entry.message.poll) {
        throw new TelegramError(
          400,
          "Bad Request: message with poll to stop not found",
        );
      }
      if (entry.message.from?.id !== caller.id) {
        throw new TelegramError(400, "Bad Request: message can't be edited");
      }
      if (entry.message.poll.is_closed) {
        throw new TelegramError(
          400,
          "Bad Request: poll has already been closed",
        );
      }
      entry.message.poll.is_closed = true;
      return entry.message.poll;
    },
    forwardMessage: (p, caller) => {
      const { source, content } = forwardable(p, caller);
      return sendFrom(
        { chat_id: p.chat_id, message_thread_id: p.message_thread_id },
        caller,
        {
          ...content,
          forward_origin:
            source.chat.type === "channel"
              ? {
                  type: "channel",
                  chat: source.message.chat,
                  message_id: source.message.message_id,
                  date: source.message.date,
                }
              : {
                  type: "user",
                  sender_user: source.message.from,
                  date: source.message.date,
                },
        },
      );
    },
    copyMessage: (p, caller) => {
      const { content } = forwardable(p, caller);
      const copy = sendFrom(p, caller, {
        ...content,
        ...(p.caption !== undefined ? { caption: String(p.caption) } : {}),
      });
      return { message_id: copy.message_id };
    },
    pinChatMessage: (p, caller) => {
      const chat = botChat(p.chat_id);
      requirePinRights(chat, caller);
      const id = Number(p.message_id);
      const entry = chat.messages.get(id);
      if (!entry || entry.deleted) {
        throw new TelegramError(400, "Bad Request: message to pin not found");
      }
      chat.pinned = [id, ...(chat.pinned ?? []).filter((each) => each !== id)];
      return true;
    },
    unpinChatMessage: (p, caller) => {
      const chat = botChat(p.chat_id);
      requirePinRights(chat, caller);
      const id =
        p.message_id == null ? (chat.pinned ?? [])[0] : Number(p.message_id);
      chat.pinned = (chat.pinned ?? []).filter((each) => each !== id);
      return true;
    },
    unpinAllChatMessages: (p, caller) => {
      const chat = botChat(p.chat_id);
      requirePinRights(chat, caller);
      chat.pinned = [];
      return true;
    },
    setChatPermissions: (p) => {
      const chat = requireChat(p.chat_id);
      chat.permissions = normalizePermissions(
        p.permissions,
        p.use_independent_chat_permissions,
      );
      return true;
    },
    leaveChat: async (p, caller) => {
      const chat = requireChat(p.chat_id);
      if (isInChat(chat, caller.id)) {
        await setBotMembership(chat, caller, { status: "left", actor: caller });
      }
      return true;
    },
    // A bot deletes its own messages, and others' with can_delete_messages.
    deleteMessage: (p, caller) => {
      const chat = botChat(p.chat_id);
      const entry = chat.messages.get(Number(p.message_id));
      if (!entry || entry.deleted) {
        throw new TelegramError(
          400,
          "Bad Request: message to delete not found",
        );
      }
      if (
        chat.type !== "private" &&
        entry.message.from?.id !== caller.id &&
        !hasRight(chat, caller.id, "can_delete_messages")
      ) {
        throw new TelegramError(400, "Bad Request: message can't be deleted");
      }
      entry.deleted = true;
      return true;
    },
    deleteMessages: (p) => {
      const chat = botChat(p.chat_id);
      if (!Array.isArray(p.message_ids)) {
        throw new TelegramError(
          400,
          "Bad Request: message_ids must be a JSON array",
        );
      }
      for (const id of p.message_ids) {
        const entry = chat.messages.get(Number(id));
        if (entry) entry.deleted = true;
      }
      return true;
    },
    restrictChatMember: (p, caller) => {
      const chat = requireChat(p.chat_id);
      const userId = Number(p.user_id);
      requireUser(userId);
      assertCanModerate(chat, userId, { self: "can't restrict self", caller });
      const before = chatMemberObject(chat, userId);
      const current = memberStatus(chat, userId);
      const permissions = normalizePermissions(
        p.permissions,
        p.use_independent_chat_permissions,
      );
      const inChat = isInChat(chat, userId);
      // Passing every permission as true lifts the restriction.
      if (PERMISSION_KEYS.every((key) => permissions[key])) {
        if (current.status === "restricted") {
          chat.members.set(userId, { status: inChat ? "member" : "left" });
        }
      } else {
        chat.members.set(userId, {
          status: "restricted",
          is_member: inChat,
          until_date: Number(p.until_date ?? 0),
          permissions,
        });
      }
      memberChanged(chat, userId, before, caller);
      return true;
    },
    banChatMember: (p, caller) => {
      const chat = requireChat(p.chat_id);
      const userId = Number(p.user_id);
      requireUser(userId);
      assertCanModerate(chat, userId, { caller });
      const before = chatMemberObject(chat, userId);
      chat.members.set(userId, {
        status: "kicked",
        until_date: Number(p.until_date ?? 0),
      });
      memberChanged(chat, userId, before, caller);
      return true;
    },
    unbanChatMember: (p, caller) => {
      const chat = requireChat(p.chat_id);
      const userId = Number(p.user_id);
      requireUser(userId);
      const current = memberStatus(chat, userId);
      const before = chatMemberObject(chat, userId);
      if (current.status === "kicked") {
        chat.members.set(userId, { status: "left" });
      } else if (isTrue(p.only_if_banned)) {
        return true;
      } else {
        // Without only_if_banned, Telegram guarantees the user is not a member
        // afterwards: a current member is removed, keeping any restriction.
        assertCanModerate(chat, userId, { caller });
        if (current.status === "restricted") {
          chat.members.set(userId, { ...current, is_member: false });
        } else if (current.status === "member") {
          chat.members.set(userId, { status: "left" });
        }
      }
      memberChanged(chat, userId, before, caller);
      return true;
    },
    approveChatJoinRequest: (p, caller) => {
      const chat = requireChat(p.chat_id);
      const userId = Number(p.user_id);
      if (!chat.joinRequests.has(userId)) {
        throw new TelegramError(400, "Bad Request: HIDE_REQUESTER_MISSING");
      }
      const request = chat.joinRequests.get(userId);
      chat.joinRequests.delete(userId);
      const before = chatMemberObject(chat, userId);
      admit(chat, userId);
      // via_join_request is only for requests made without an invite link;
      // every request here came through one, so the link is reported instead.
      emitMemberChange(chat, userId, before, caller, {
        ...(request.invite_link
          ? { invite_link: request.invite_link }
          : { via_join_request: true }),
      });
      const user = requireUser(userId);
      emit(
        "message",
        addMessage(chat, user, { new_chat_members: [userObject(user)] }),
      );
      return true;
    },
    declineChatJoinRequest: (p) => {
      const chat = requireChat(p.chat_id);
      const userId = Number(p.user_id);
      if (!chat.joinRequests.delete(userId)) {
        throw new TelegramError(400, "Bad Request: HIDE_REQUESTER_MISSING");
      }
      return true;
    },
    createChatInviteLink: (p, caller) => {
      const chat = requireChat(p.chat_id);
      const link = `https://t.me/+fake${randomBytes(9).toString("base64url")}`;
      const invite = {
        invite_link: link,
        creator: userObject(caller),
        creates_join_request: String(p.creates_join_request) === "true",
        is_primary: false,
        is_revoked: false,
        ...(p.name ? { name: String(p.name) } : {}),
      };
      chat.inviteLinks.set(link, invite);
      return invite;
    },
    exportChatInviteLink: (p, caller) => {
      const chat = requireChat(p.chat_id);
      // A new primary link revokes the previous one.
      for (const invite of chat.inviteLinks.values()) {
        if (invite.is_primary) invite.is_revoked = true;
      }
      const invite = methods.createChatInviteLink(
        { chat_id: p.chat_id },
        caller,
      );
      invite.is_primary = true;
      return invite.invite_link;
    },
    sendVoice: (p, caller) => sendMedia(p, caller, "voice"),
    sendAudio: (p, caller) => sendMedia(p, caller, "audio"),
    sendVideoNote: (p, caller) => sendMedia(p, caller, "video_note"),
    sendLocation: (p, caller) =>
      sendFrom(p, caller, { location: coordinates(p) }),
    sendVenue: (p, caller) => {
      if (!p.title || !p.address) {
        throw new TelegramError(
          400,
          "Bad Request: venue needs title and address",
        );
      }
      const location = coordinates(p);
      return sendFrom(p, caller, {
        venue: { location, title: String(p.title), address: String(p.address) },
        location,
      });
    },
    sendContact: (p, caller) => {
      if (!p.phone_number || !p.first_name) {
        throw new TelegramError(
          400,
          "Bad Request: contact needs phone_number and first_name",
        );
      }
      return sendFrom(p, caller, {
        contact: {
          phone_number: String(p.phone_number),
          first_name: String(p.first_name),
          ...(p.last_name ? { last_name: String(p.last_name) } : {}),
        },
      });
    },
    sendDice: (p, caller) => {
      const emoji = p.emoji ?? "🎲";
      if (!DICE[emoji]) {
        throw new TelegramError(400, "Bad Request: invalid dice emoji");
      }
      return sendFrom(p, caller, {
        dice: { emoji, value: 1 + Math.floor(Math.random() * DICE[emoji]) },
      });
    },
    sendChatAction: (p, caller) => {
      const chat = botChat(p.chat_id);
      if (!CHAT_ACTIONS.has(p.action)) {
        throw new TelegramError(
          400,
          "Bad Request: wrong parameter action in request",
        );
      }
      requireCanSend(chat, caller);
      return true;
    },
    // An album of 2 to 10 photos and videos, or of documents or audios alone.
    sendMediaGroup: (p, caller) => {
      const items = Array.isArray(p.media) ? p.media : [];
      if (items.length < 2 || items.length > 10) {
        throw new TelegramError(
          400,
          "Bad Request: media group must include 2-10 items",
        );
      }
      const types = items.map((item) => item?.type);
      if (
        types.some(
          (type) => !["photo", "video", "document", "audio"].includes(type),
        )
      ) {
        throw new TelegramError(400, "Bad Request: unsupported media type");
      }
      for (const alone of ["document", "audio"]) {
        if (types.includes(alone) && types.some((type) => type !== alone)) {
          throw new TelegramError(
            400,
            `Bad Request: ${alone}s can't be mixed with other media types`,
          );
        }
      }
      const chat = botChat(p.chat_id);
      requireCanSend(chat, caller);
      const mediaGroupId = String(nextMediaGroupId++);
      return items.map((item) => {
        const reference =
          typeof item.media === "string" && item.media.startsWith("attach://")
            ? p[item.media.slice("attach://".length)]
            : item.media;
        const file =
          typeof reference === "string" && files.has(reference)
            ? sentFile(reference)
            : Buffer.isBuffer(reference)
              ? item.type === "photo"
                ? registerPhoto(reference)
                : registerFile(reference, `${item.type}s`, "bin")
              : null;
        if (!file) {
          throw new TelegramError(
            400,
            "Bad Request: wrong file identifier/HTTP URL specified",
          );
        }
        return sendFrom(
          { chat_id: p.chat_id, message_thread_id: p.message_thread_id },
          caller,
          {
            ...mediaFields(item.type, file, {}),
            ...(item.caption ? { caption: String(item.caption) } : {}),
            media_group_id: mediaGroupId,
          },
        );
      });
    },
    promoteChatMember: async (p, caller) => {
      const chat = requireChat(p.chat_id);
      const userId = Number(p.user_id);
      requireUser(userId);
      if (!hasRight(chat, caller.id, "can_promote_members")) {
        throw new TelegramError(400, "Bad Request: not enough rights");
      }
      const current = memberStatus(chat, userId);
      if (current.status === "creator") {
        throw new TelegramError(400, "Bad Request: USER_CREATOR");
      }
      if (!isInChat(chat, userId)) {
        throw new TelegramError(400, "Bad Request: USER_NOT_PARTICIPANT");
      }
      if (
        current.status === "administrator" &&
        current.promotedBy !== caller.id
      ) {
        throw new TelegramError(400, "Bad Request: CHAT_ADMIN_REQUIRED");
      }
      const rights = Object.fromEntries(
        ADMIN_RIGHTS.map((right) => [right, isTrue(p[right])]),
      );
      for (const [right, granted] of Object.entries(rights)) {
        if (
          granted &&
          right !== "is_anonymous" &&
          right !== "can_manage_chat" &&
          !hasRight(chat, caller.id, right)
        ) {
          throw new TelegramError(400, "Bad Request: RIGHT_FORBIDDEN");
        }
      }
      const before = chatMemberObject(chat, userId);
      if (Object.values(rights).some(Boolean)) {
        // Any right implies can_manage_chat, as on Telegram.
        chat.members.set(userId, {
          status: "administrator",
          rights: { ...rights, can_manage_chat: true },
          promotedBy: caller.id,
        });
      } else {
        chat.members.set(userId, { status: "member" });
      }
      await memberChanged(chat, userId, before, caller);
      return true;
    },
    setChatAdministratorCustomTitle: async (p, caller) => {
      const chat = requireChat(p.chat_id);
      const userId = Number(p.user_id);
      const member = memberStatus(chat, userId);
      if (
        member.status !== "administrator" ||
        member.promotedBy !== caller.id
      ) {
        throw new TelegramError(
          400,
          "Bad Request: not enough rights to change custom title of the user",
        );
      }
      const title = String(p.custom_title ?? "");
      if (/\p{Extended_Pictographic}/u.test(title)) {
        throw new TelegramError(
          400,
          "Bad Request: ADMIN_RANK_EMOJI_NOT_ALLOWED",
        );
      }
      if ([...title].length > 16) {
        throw new TelegramError(400, "Bad Request: ADMIN_RANK_INVALID");
      }
      const before = chatMemberObject(chat, userId);
      chat.members.set(userId, { ...member, customTitle: title || undefined });
      await memberChanged(chat, userId, before, caller);
      return true;
    },
    setChatTitle: async (p, caller) => {
      const chat = requireChat(p.chat_id);
      requireInfoRight(chat, caller, "title");
      const title = String(p.title ?? "").trim();
      if (!title || title.length > 128) {
        throw new TelegramError(400, "Bad Request: chat title can't be empty");
      }
      if (title === chat.title) {
        throw new TelegramError(400, "Bad Request: chat title is not modified");
      }
      chat.title = title;
      await emit(
        "message",
        addMessage(chat, caller, { new_chat_title: title }),
        { except: caller.id },
      );
      return true;
    },
    setChatDescription: (p, caller) => {
      const chat = requireChat(p.chat_id);
      requireInfoRight(chat, caller, "description");
      const description = String(p.description ?? "");
      if (description.length > 255) {
        throw new TelegramError(
          400,
          "Bad Request: chat description is too long",
        );
      }
      if (description === (chat.description ?? "")) {
        throw new TelegramError(
          400,
          "Bad Request: chat description is not modified",
        );
      }
      chat.description = description || undefined;
      return true;
    },
    setChatPhoto: async (p, caller) => {
      const chat = requireChat(p.chat_id);
      requireInfoRight(chat, caller, "photo");
      if (!Buffer.isBuffer(p.photo)) {
        throw new TelegramError(
          400,
          "Bad Request: there is no photo in the request",
        );
      }
      chat.photo = registerPhoto(p.photo);
      await emit(
        "message",
        addMessage(chat, caller, { new_chat_photo: photoSizes(chat.photo) }),
        { except: caller.id },
      );
      return true;
    },
    deleteChatPhoto: async (p, caller) => {
      const chat = requireChat(p.chat_id);
      requireInfoRight(chat, caller, "photo");
      if (!chat.photo) {
        throw new TelegramError(400, "Bad Request: CHAT_NOT_MODIFIED");
      }
      chat.photo = undefined;
      await emit(
        "message",
        addMessage(chat, caller, { delete_chat_photo: true }),
        { except: caller.id },
      );
      return true;
    },
    editChatInviteLink: (p, caller) => {
      const chat = requireChat(p.chat_id);
      const invite = chat.inviteLinks.get(String(p.invite_link));
      if (!invite || invite.is_revoked) {
        throw new TelegramError(400, "Bad Request: INVITE_HASH_EXPIRED");
      }
      if (invite.creator.id !== caller.id) {
        throw new TelegramError(400, "Bad Request: CHAT_ADMIN_REQUIRED");
      }
      const createsJoinRequest =
        p.creates_join_request !== undefined
          ? isTrue(p.creates_join_request)
          : invite.creates_join_request;
      const memberLimit =
        p.member_limit !== undefined ? p.member_limit : invite.member_limit;
      if (createsJoinRequest && memberLimit != null) {
        throw new TelegramError(
          400,
          "Bad Request: member limit can't be specified for links requiring administrator approval",
        );
      }
      if (p.name !== undefined) invite.name = String(p.name);
      if (p.expire_date !== undefined)
        invite.expire_date = Number(p.expire_date);
      if (p.member_limit !== undefined)
        invite.member_limit = Number(p.member_limit);
      invite.creates_join_request = createsJoinRequest;
      return { ...invite };
    },
    // A bot sets at most one reaction of its own on a message.
    setMessageReaction: (p, caller) => {
      const chat = botChat(p.chat_id);
      const entry = chat.messages.get(Number(p.message_id));
      if (!entry || entry.deleted) {
        throw new TelegramError(400, "Bad Request: MESSAGE_ID_INVALID");
      }
      const reactions = Array.isArray(p.reaction) ? p.reaction : [];
      if (reactions.length > 1) {
        throw new TelegramError(400, "Bad Request: REACTIONS_TOO_MANY");
      }
      entry.reactions ??= new Map();
      if (reactions.length) {
        entry.reactions.set(
          caller.id,
          reactions.map((reaction) => String(reaction.emoji ?? "")),
        );
      } else entry.reactions.delete(caller.id);
      return true;
    },
    // Removes a user's reaction; needs can_delete_messages.
    deleteMessageReaction: async (p, caller) => {
      const chat = requireChat(p.chat_id);
      if (!hasRight(chat, caller.id, "can_delete_messages")) {
        throw new TelegramError(
          400,
          "Bad Request: not enough rights to delete reactions",
        );
      }
      const entry = chat.messages.get(Number(p.message_id));
      if (!entry || entry.deleted) {
        throw new TelegramError(400, "Bad Request: MESSAGE_ID_INVALID");
      }
      const user = requireUser(p.user_id);
      if (entry.reactions?.has(user.id)) {
        await changeReaction(chat, entry, user, []);
      }
      return true;
    },
    // A guard bot answers a join request query: approve, decline, or leave it
    // to the other administrators.
    answerChatJoinRequestQuery: (p, caller) => {
      const id = String(p.chat_join_request_query_id ?? "");
      const query = joinQueries.get(id);
      if (!query || query.botId !== caller.id) {
        throw new TelegramError(
          400,
          "Bad Request: query is too old and response timeout expired or query ID is invalid",
        );
      }
      if (!["approve", "decline", "queue"].includes(p.result)) {
        throw new TelegramError(
          400,
          'Bad Request: result must be "approve", "decline" or "queue"',
        );
      }
      joinQueries.delete(id);
      const target = { chat_id: query.chatId, user_id: query.userId };
      if (p.result === "approve")
        methods.approveChatJoinRequest(target, caller);
      if (p.result === "decline")
        methods.declineChatJoinRequest(target, caller);
      return true;
    },
    revokeChatInviteLink: (p) => {
      const chat = requireChat(p.chat_id);
      const invite = chat.inviteLinks.get(String(p.invite_link));
      if (invite) invite.is_revoked = true;
      return {
        ...(invite ?? { invite_link: p.invite_link }),
        is_revoked: true,
      };
    },
  };

  const methodsByLowerName = new Map(
    Object.entries(methods).map(([name, handler]) => [
      name.toLowerCase(),
      handler,
    ]),
  );

  function isTrue(value) {
    return value === true || value === "true";
  }

  /** An inline keyboard with at least one row, or undefined. */
  function inlineMarkup(markup) {
    return Array.isArray(markup?.inline_keyboard) &&
      markup.inline_keyboard.length > 0
      ? markup
      : undefined;
  }

  function sendFrom(p, caller, fields) {
    // Message.reply_markup only ever carries an inline keyboard; reply
    // keyboards and ForceReply are shown to the user, not echoed back.
    const markup = inlineMarkup(p.reply_markup);
    // An ephemeral message (Bot API 10.2) is shown to one member only. Telegram
    // gives it message_id 0; here it keeps the chat's message id, so tests can
    // find and press it like any message, and reuses it as ephemeral_message_id.
    const receiverId = p.ephemeral_message_parameters?.receiver_user_id;
    const chat = botChat(p.chat_id);
    requireCanSend(chat, caller);
    requireTopic(chat, p.message_thread_id);
    const replyTo = replyTarget(chat, p);
    const message = addMessage(chat, caller, {
      ...fields,
      ...(replyTo ? { reply_to_message: replyTo } : {}),
      ...(markup ? { reply_markup: markup } : {}),
      ...(p.message_thread_id && chat.topics
        ? {
            message_thread_id: Number(p.message_thread_id),
            is_topic_message: true,
          }
        : {}),
      ...(receiverId != null
        ? { receiver_user: userObject(requireUser(receiverId)) }
        : {}),
    });
    if (receiverId != null) message.ephemeral_message_id = message.message_id;
    return message;
  }

  /**
   * The message a bot send answers: reply_parameters (or the older
   * reply_to_message_id), else, in a forum topic, the topic's creation message.
   */
  function replyTarget(chat, p) {
    const parameters =
      p.reply_parameters ??
      (p.reply_to_message_id != null
        ? {
            message_id: p.reply_to_message_id,
            allow_sending_without_reply: p.allow_sending_without_reply,
          }
        : null);
    if (parameters?.message_id != null) {
      if (
        parameters.chat_id != null &&
        String(parameters.chat_id) !== String(chat.id) &&
        String(parameters.chat_id) !== String(p.chat_id)
      ) {
        throw new TelegramError(
          400,
          "Bad Request: replies to other chats are not supported here",
        );
      }
      const entry = chat.messages.get(Number(parameters.message_id));
      if (entry && !entry.deleted) {
        const { reply_to_message: _nested, ...original } = entry.message;
        return original;
      }
      if (parameters.allow_sending_without_reply === true) return null;
      throw new TelegramError(
        400,
        "Bad Request: message to be replied not found",
      );
    }
    if (p.message_thread_id && chat.topics) {
      const topic = chat.messages.get(Number(p.message_thread_id));
      if (topic) {
        const { reply_to_message: _nested, ...original } = topic.message;
        return original;
      }
    }
    return null;
  }

  /** text and entities of a bot's message, after parse_mode or explicit entities. */
  function textFields(p) {
    const formatted = formatOrFail(
      String(p.text ?? ""),
      p.parse_mode,
      p.entities,
    );
    if (!formatted.text.trim()) {
      throw new TelegramError(400, "Bad Request: message text is empty");
    }
    return {
      text: formatted.text,
      ...(formatted.entities.length > 0
        ? { entities: formatted.entities }
        : {}),
    };
  }

  /** caption and caption_entities of a bot's media message. */
  function captionFields(p) {
    if (p.caption == null || p.caption === "") return {};
    const formatted = formatOrFail(
      String(p.caption),
      p.parse_mode,
      p.caption_entities,
    );
    return {
      caption: formatted.text,
      ...(formatted.entities.length > 0
        ? { caption_entities: formatted.entities }
        : {}),
    };
  }

  function formatOrFail(text, parseMode, entities) {
    try {
      return formatText(text, { parseMode, entities, detect: messageEntities });
    } catch (error) {
      if (error instanceof FormattingError) {
        throw new TelegramError(400, error.message);
      }
      throw error;
    }
  }

  /** A bot sends a voice note, audio file or video note. */
  function sendMedia(p, caller, type) {
    const file = sentFile(p[type], `${type}s`, MEMBER_MEDIA[type].ext);
    return sendFrom(p, caller, {
      ...mediaFields(type, file, {
        duration: p.duration == null ? 1 : Number(p.duration),
        fileName: file.file_name,
        mimeType: file.mime_type,
      }),
      ...(MEMBER_MEDIA[type].caption ? captionFields(p) : {}),
    });
  }

  function coordinates(p) {
    const latitude = Number(p.latitude);
    const longitude = Number(p.longitude);
    if (
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude) ||
      Math.abs(latitude) > 90 ||
      Math.abs(longitude) > 180
    ) {
      throw new TelegramError(400, "Bad Request: wrong latitude or longitude");
    }
    return { latitude, longitude };
  }

  /** Changing a chat's title, description or photo needs can_change_info. */
  function requireInfoRight(chat, caller, what) {
    if (!hasRight(chat, caller.id, "can_change_info")) {
      throw new TelegramError(
        400,
        `Bad Request: not enough rights to change chat ${what}`,
      );
    }
  }

  // ── Business connections ────────────────────────────────────────────────
  function businessConnectionObject(connection) {
    return {
      id: connection.id,
      user: userObject(requireUser(connection.ownerId)),
      user_chat_id: connection.ownerId,
      date: connection.date,
      rights: { ...connection.rights },
      is_enabled: connection.isEnabled,
    };
  }

  /**
   * The caller's connection with that id. Telegram names an unknown one
   * BUSINESS_CONNECTION_INVALID (400) at the MTProto layer; the Bot API's
   * exact wording is UNVERIFIED.
   * https://core.telegram.org/method/messages.sendMessage
   * https://core.telegram.org/api/bots/connected-business-bots
   */
  function requireBusinessConnection(id, caller) {
    const connection = businessConnections.get(String(id ?? ""));
    if (!connection || connection.botId !== caller.id) {
      throw new TelegramError(400, "Bad Request: BUSINESS_CONNECTION_INVALID");
    }
    return connection;
  }

  function businessChat(connection, userId) {
    const key = Number(userId);
    if (!connection.chats.has(key)) {
      connection.chats.set(key, {
        entries: [],
        nextMessageId: 1,
        lastInboundAt: null,
      });
    }
    return connection.chats.get(key);
  }

  /** A business chat is the owner's private chat with a person. */
  function businessChatObject(userId) {
    const user = requireUser(userId);
    return {
      id: user.id,
      type: "private",
      first_name: user.first_name,
      ...(user.last_name ? { last_name: user.last_name } : {}),
      ...(user.username ? { username: user.username } : {}),
    };
  }

  function addBusinessMessage(connection, userId, direction, from, fields) {
    const chat = businessChat(connection, userId);
    const message = {
      message_id: chat.nextMessageId++,
      from: userObject(from),
      chat: businessChatObject(userId),
      date: now(),
      business_connection_id: connection.id,
      ...fields,
    };
    if (message.text) {
      const entities = messageEntities(message.text);
      if (entities.length > 0) message.entities = entities;
    }
    chat.entries.push({ direction, deleted: false, message });
    return message;
  }

  /**
   * The bot answers in a business chat, as the owner. It needs an enabled
   * connection with can_reply, and can_reply covers only chats "that had
   * incoming messages in the last 24 hours"
   * (https://core.telegram.org/bots/api#businessbotrights); past that,
   * Telegram answers BUSINESS_PEER_USAGE_MISSING
   * (https://core.telegram.org/method/messages.sendMessage).
   */
  function sendBusinessMessage(p, caller) {
    const connection = requireBusinessConnection(
      p.business_connection_id,
      caller,
    );
    // UNVERIFIED: Telegram does not document the error for a disabled
    // connection; a disabled connection is treated as an invalid one.
    if (!connection.isEnabled) {
      throw new TelegramError(400, "Bad Request: BUSINESS_CONNECTION_INVALID");
    }
    // BOT_ACCESS_FORBIDDEN is Telegram's error for an operation a business
    // connection does not allow (connected-business-bots page); that a missing
    // can_reply right produces it, with 403, is UNVERIFIED.
    if (connection.rights.can_reply !== true) {
      throw new TelegramError(403, "Forbidden: BOT_ACCESS_FORBIDDEN");
    }
    const userId = Number(p.chat_id);
    requireUser(userId);
    const chat = businessChat(connection, userId);
    if (
      chat.lastInboundAt == null ||
      Date.now() - chat.lastInboundAt > 24 * 60 * 60 * 1000
    ) {
      throw new TelegramError(400, "Bad Request: BUSINESS_PEER_USAGE_MISSING");
    }
    return addBusinessMessage(
      connection,
      userId,
      "bot",
      requireUser(connection.ownerId),
      {
        text: String(p.text ?? ""),
        sender_business_bot: userObject(caller),
      },
    );
  }

  /**
   * A test connects a bot to an owner's account, or changes an existing
   * connection (rights, enabled). Telegram sends the bot business_connection
   * each time.
   */
  function connectBusiness(body) {
    const existing =
      body.id != null ? businessConnections.get(String(body.id)) : null;
    const ownerId = Number(body.owner_id ?? existing?.ownerId);
    const owner = requireUser(ownerId);
    if (owner.is_bot) {
      throw new TelegramError(
        400,
        "a business account owner is a user, not a bot",
      );
    }
    const record =
      body.bot_id != null
        ? requireBot(body.bot_id)
        : existing
          ? requireBot(existing.botId)
          : bot;
    const connection = existing ?? {
      id: String(
        body.id ?? `fake-business-${randomBytes(9).toString("base64url")}`,
      ),
      ownerId,
      botId: record.id,
      date: now(),
      chats: new Map(),
    };
    connection.ownerId = ownerId;
    connection.botId = record.id;
    connection.rights = { ...(body.rights ?? existing?.rights ?? {}) };
    connection.isEnabled =
      body.is_enabled !== undefined
        ? body.is_enabled === true
        : (existing?.isEnabled ?? true);
    businessConnections.set(connection.id, connection);
    // The owner's private chat with the bot is open to it from now on.
    const privateChat = messageChat(ownerId);
    privateChat.openTo ??= new Set();
    privateChat.openTo.add(record.id);
    const sent = emitOne(
      record,
      "business_connection",
      businessConnectionObject(connection),
    );
    return {
      connection: businessConnectionObject(connection),
      update_id: sent.updateId,
      delivered: sent.delivered,
    };
  }

  /**
   * A message in a business chat: from the person, or from the owner answering
   * by hand. The bot gets business_message while the connection is enabled.
   */
  async function sayInBusinessChat(connectionId, userId, { sender, text }) {
    const connection = businessConnections.get(String(connectionId));
    if (!connection) {
      throw new TelegramError(404, `No business connection ${connectionId}`);
    }
    if (sender !== "person" && sender !== "owner") {
      throw new TelegramError(400, 'sender must be "person" or "owner"');
    }
    const from = requireUser(sender === "person" ? userId : connection.ownerId);
    requireUser(userId);
    const message = addBusinessMessage(
      connection,
      userId,
      sender === "person" ? "inbound" : "owner",
      from,
      { text: String(text ?? "") },
    );
    if (sender === "person")
      businessChat(connection, userId).lastInboundAt = Date.now();
    let updateId = null;
    if (connection.isEnabled) {
      const sent = emitOne(
        requireBot(connection.botId),
        "business_message",
        structuredClone(message),
      );
      updateId = sent.updateId;
      await sent.delivered;
    }
    return {
      message_id: message.message_id,
      date: message.date,
      update_id: updateId,
    };
  }

  /** The message a forward or copy reads, when the bot can see it. */
  function forwardable(p, caller) {
    const sourceChat = botChat(p.from_chat_id);
    const entry = sourceChat.messages.get(Number(p.message_id));
    if (
      !entry ||
      entry.deleted ||
      (sourceChat.type !== "private" && !isInChat(sourceChat, caller.id))
    ) {
      throw new TelegramError(400, "Bad Request: message to forward not found");
    }
    const {
      message_id: _id,
      from: _from,
      chat: _chat,
      date: _date,
      edit_date: _edited,
      reply_markup: _markup,
      reply_to_message: _reply,
      receiver_user: _receiver,
      ephemeral_message_id: _ephemeral,
      forward_origin: _origin,
      message_thread_id: _thread,
      is_topic_message: _topic,
      ...content
    } = structuredClone(entry.message);
    return { source: { chat: sourceChat, message: entry.message }, content };
  }

  /**
   * Apply a bot edit to a stored message, as Telegram does: only the bot's own
   * messages can be edited, an edit without reply_markup removes the inline
   * keyboard, and an edit that changes nothing is refused.
   */
  function editMessage(p, caller, apply) {
    const chat = botChat(p.chat_id);
    const entry = chat.messages.get(Number(p.message_id));
    if (!entry || entry.deleted) {
      throw new TelegramError(400, "Bad Request: message to edit not found");
    }
    if (entry.message.from.id !== caller.id) {
      throw new TelegramError(400, "Bad Request: message can't be edited");
    }
    const previous = structuredClone(entry.message);
    const edited = structuredClone(entry.message);
    apply(edited);
    const markup = inlineMarkup(p.reply_markup);
    if (markup) edited.reply_markup = markup;
    else delete edited.reply_markup;
    const same = (message) =>
      JSON.stringify([
        message.text,
        message.entities,
        message.caption,
        message.caption_entities,
        message.reply_markup,
        ...MEDIA_KINDS.map((kind) => message[kind]),
      ]);
    if (same(edited) === same(previous)) {
      throw new TelegramError(
        400,
        "Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message",
      );
    }
    edited.edit_date = now();
    entry.message = edited;
    return edited;
  }

  /** A group, forum or channel with its owner and no bot in it yet. */
  function createChat({
    title,
    type,
    owner_id: ownerId,
    owner_name,
    is_forum,
  }) {
    if (
      type !== undefined &&
      !["supergroup", "channel", "group"].includes(type)
    ) {
      throw new TelegramError(
        400,
        'type must be "supergroup", "channel" or "group"',
      );
    }
    const kind = type ?? "supergroup";
    const owner = Number(ownerId);
    if (!Number.isSafeInteger(owner) || owner <= 0) {
      throw new TelegramError(400, "chat needs an owner_id");
    }
    if (!users.has(owner)) {
      users.set(owner, {
        id: owner,
        is_bot: false,
        first_name: owner_name ?? "Chat Owner",
        bio: "",
        photos: [],
      });
    }
    nextChatId += 1;
    const chat = {
      id:
        kind === "group"
          ? -nextBasicGroupId++
          : -(1_000_000_000_000 + nextChatId),
      title: String(title ?? (kind === "channel" ? "Channel" : "Group")),
      type: kind,
      members: new Map([[owner, { status: "creator" }]]),
      messages: new Map(),
      nextMessageId: startSeconds - 1_700_000_000,
      inviteLinks: new Map(),
      joinRequests: new Map(),
      permissions: { ...ALL_PERMISSIONS },
      // A forum keeps its topics by thread id.
      ...(kind === "supergroup" && isTrue(is_forum)
        ? { topics: new Map() }
        : {}),
    };
    chats.set(chat.id, chat);
    return chat;
  }

  function creatorOf(chat) {
    return [...chat.members.entries()].find(
      ([, member]) => member.status === "creator",
    )?.[0];
  }

  // ── Test controls (/_fake/*) ───────────────────────────────────────────
  async function control(method, parts, body) {
    const [resource, id, sub, subId] = parts;
    if (resource === "owners") {
      try {
        return ownerModel.control(method, parts.slice(1), body);
      } catch (error) {
        if (error instanceof OwnerError) {
          throw new TelegramError(error.status, error.message);
        }
        throw error;
      }
    }
    if (resource === "bots" && !id && method === "POST") {
      try {
        return userObject(
          addBot({
            token: String(body.token ?? ""),
            username: body.username,
            firstName: body.first_name,
            joinRequestQueries: body.supports_join_request_queries === true,
            loginClientSecret: body.login_client_secret,
          }),
        );
      } catch (error) {
        throw new TelegramError(400, error.message);
      }
    }
    if (resource === "bots" && !id && method === "GET") {
      return [...bots.values()].map((record) => ({
        ...userObject(record),
        webhook: record.webhook ? { url: record.webhook.url } : null,
        login_client_secret: record.loginClientSecret,
      }));
    }
    if (resource === "chats" && !id && method === "POST") {
      return chatObject(createChat(body));
    }
    if (resource === "chats" && id && !sub && method === "GET") {
      const chat = requireChat(id);
      return {
        ...chatObject(chat),
        pinned: [...(chat.pinned ?? [])],
        members: [...chat.members.entries()].map(([userId, member]) => ({
          user_id: userId,
          status: member.status,
        })),
      };
    }
    if (resource === "chats" && id && sub === "bots" && method === "POST") {
      // The owner (or `by`) adds, promotes, demotes or removes a bot.
      const chat = requireChat(id);
      const record = requireBot(body.bot_id);
      if (body.start_parameter !== undefined) {
        return addBotViaLink(chat, record, {
          by: body.by,
          startParameter: body.start_parameter,
          rights: body.rights ?? null,
        });
      }
      const status = body.status ?? "administrator";
      if (!["administrator", "member", "left", "kicked"].includes(status)) {
        throw new TelegramError(
          400,
          'status must be "administrator", "member", "left" or "kicked"',
        );
      }
      return setBotMembership(chat, record, {
        status,
        rights: body.rights ?? null,
        actor: requireUser(body.by ?? creatorOf(chat)),
      });
    }
    if (resource === "chats" && id && sub === "migrate" && method === "POST") {
      return migrateToSupergroup(requireChat(id), body);
    }
    if (resource === "chats" && id && sub === "title" && method === "POST") {
      return renameByPerson(requireChat(id), body);
    }
    if (resource === "chats" && id && sub === "photo" && method === "POST") {
      return changePhotoByPerson(requireChat(id), body);
    }
    if (resource === "failures" && method === "POST") {
      if (typeof body.method !== "string" || body.method === "") {
        throw new TelegramError(
          400,
          "a failure needs the method it applies to",
        );
      }
      const rule = {
        method: body.method,
        chat_id: body.chat_id == null ? null : String(body.chat_id),
        bot_id: body.bot_id == null ? null : Number(body.bot_id),
        remaining: Math.max(1, numberParam(body.times, 1)),
        error_code: numberParam(body.error_code, 400),
        description: String(body.description ?? "Bad Request"),
        retry_after:
          body.retry_after == null ? null : numberParam(body.retry_after, 1),
        drop_after_apply: body.drop_after_apply === true,
      };
      failures.push(rule);
      return rule;
    }
    if (resource === "failures" && method === "GET") return failures;
    if (resource === "failures" && method === "DELETE") {
      failures.length = 0;
      return { ok: true };
    }
    if (resource === "business" && id === "connections") {
      const [, , connectionId, chatsPart, userId, messagesPart] = parts;
      if (method === "POST" && !connectionId) {
        const { delivered, ...result } = connectBusiness(body);
        await delivered;
        return result;
      }
      if (method === "GET" && connectionId && !chatsPart) {
        const connection = businessConnections.get(String(connectionId));
        if (!connection) {
          throw new TelegramError(
            404,
            `No business connection ${connectionId}`,
          );
        }
        return businessConnectionObject(connection);
      }
      if (chatsPart === "chats" && userId && messagesPart === "messages") {
        const connection = businessConnections.get(String(connectionId));
        if (!connection) {
          throw new TelegramError(
            404,
            `No business connection ${connectionId}`,
          );
        }
        if (method === "POST")
          return sayInBusinessChat(connectionId, userId, body);
        if (method === "GET") {
          return [...businessChat(connection, userId).entries]
            .reverse()
            .map((entry) => structuredClone(entry));
        }
      }
    }
    if (
      resource === "updates" &&
      id &&
      sub === "redeliver" &&
      method === "POST"
    ) {
      // Telegram delivers an update again when a webhook did not confirm it;
      // this sends the same bytes to the same bot.
      const sent = sentUpdates.get(Number(id));
      if (!sent) throw new TelegramError(404, `No update ${id}`);
      if (!sent.record.webhook?.url) {
        throw new TelegramError(409, `The bot for update ${id} has no webhook`);
      }
      await deliver(sent.record, JSON.parse(sent.body), sent.body);
      return { update_id: Number(id) };
    }
    if (resource === "users" && method === "POST" && !id) {
      const user = {
        id: nextUserId++,
        is_bot: body.is_bot === true,
        is_premium: body.is_premium === true,
        first_name: body.first_name ?? "Test Member",
        last_name: body.last_name ?? "",
        username: body.username ?? null,
        language_code: body.language_code ?? "en",
        bio: body.bio ?? "",
        photos: [],
      };
      users.set(user.id, user);
      return { id: user.id };
    }
    if (resource === "users" && id) {
      const user = requireUser(id);
      if (!sub && method === "GET") {
        return { ...userObject(user), bio: user.bio, photos: user.photos };
      }
      if (sub === "profile" && method === "POST") {
        for (const key of ["first_name", "last_name", "bio", "username"]) {
          if (key in body) user[key] = body[key];
        }
        return { ok: true };
      }
      if (sub === "photos" && method === "POST") {
        if (typeof body.base64 !== "string" || body.base64 === "") {
          throw new TelegramError(400, "photo needs base64 image bytes");
        }
        const photo = registerPhoto(Buffer.from(body.base64, "base64"));
        user.photos.unshift(photo);
        return photo;
      }
      if (sub === "photos" && method === "DELETE") {
        user.photos = user.photos.filter((p) => p.file_id !== subId);
        return { ok: true };
      }
    }
    if (resource === "chats" && id) {
      const chat = requireChat(id);
      if (sub === "join" && method === "POST") return join(chat, body);
      if (sub === "leave" && method === "POST") return leave(chat, body);
      if (sub === "messages" && method === "POST" && !subId)
        return post(chat, body);
      if (sub === "messages" && method === "GET" && !subId) {
        return [...chat.messages.values()]
          .filter((entry) => !entry.deleted)
          .map((entry) => entry.message)
          .sort((left, right) => right.message_id - left.message_id);
      }
      if (sub === "messages" && method === "GET" && subId) {
        const entry = chat.messages.get(Number(subId));
        return entry
          ? {
              exists: true,
              deleted: entry.deleted,
              message: entry.message,
              reactions: Object.fromEntries(entry.reactions ?? []),
            }
          : { exists: false, deleted: false };
      }
      if (sub === "members" && method === "GET" && subId) {
        return chatMemberObject(chat, subId);
      }
      if (sub === "topics") {
        if (!chat.topics) {
          throw new TelegramError(400, "Bad Request: the chat is not a forum");
        }
        return topicControl(chat, method, subId, parts[4], body);
      }
      if (sub === "join-requests" && method === "GET") {
        return [...chat.joinRequests.keys()];
      }
    }
    if (resource === "invites" && id) {
      let hash;
      try {
        hash = decodeURIComponent(id);
      } catch {
        throw new TelegramError(400, "INVITE_HASH_INVALID");
      }
      const link = `https://t.me/+${hash}`;
      const chat = [...chats.values()].find((c) => c.inviteLinks.has(link));
      if (!chat) throw new TelegramError(400, "INVITE_HASH_INVALID");
      if (sub === "join" && method === "POST") {
        return {
          chat_id: chat.id,
          ...(await join(chat, { ...body, invite_link: link })),
        };
      }
      if (sub === "check" && method === "POST") {
        return {
          chat_id: chat.id,
          title: chat.title,
          member: isInChat(chat, body.user_id),
        };
      }
    }
    if (resource === "bot" && method === "GET") {
      return { ...userObject(bot), login_client_secret: bot.loginClientSecret };
    }
    if (resource === "login" && (id === "approve" || id === "cancel")) {
      // What the login page's buttons do, without a browser.
      const request = loginRequest(
        new URL(String(body.auth_url ?? ""), "http://fake").searchParams,
      );
      if (request.error) throw new TelegramError(400, request.error);
      return {
        redirect_url:
          id === "approve"
            ? approveLogin(request, requireUser(body.user_id))
            : loginRedirect(request.redirectUri, {
                error: "access_denied",
                state: request.state,
              }),
      };
    }
    if (resource === "users" && id && sub === "dm") {
      // Only the user writing to the bot opens their private chat; reading it
      // must not, or the bot could then message a user who never wrote.
      const existing = privateChats.get(Number(id));
      if (method === "GET" && !subId) {
        requireUser(id);
        return existing
          ? [...existing.messages.values()]
              .filter((entry) => !entry.deleted)
              .map((entry) => entry.message)
              .sort((left, right) => right.message_id - left.message_id)
          : [];
      }
      if (method === "POST" && subId && parts[4] === "callback") {
        if (!existing) throw new TelegramError(400, "MESSAGE_ID_INVALID");
        return pressButton(existing, requireUser(id), Number(subId), body.data);
      }
      const chat = messageChat(id);
      if (method === "POST" && !subId) {
        return post(chat, { ...body, user_id: Number(id) });
      }
    }
    if (resource === "chats" && id && sub === "albums" && method === "POST") {
      return postAlbum(requireChat(id), body);
    }
    if (
      resource === "chats" &&
      id &&
      sub === "messages" &&
      subId &&
      parts[4] === "edit" &&
      method === "POST"
    ) {
      return editByMember(requireChat(id), subId, body);
    }
    if (
      resource === "chats" &&
      id &&
      sub === "messages" &&
      subId &&
      parts[4] === "reactions" &&
      method === "POST"
    ) {
      return reactByMember(requireChat(id), subId, body);
    }
    if (
      resource === "chats" &&
      id &&
      sub === "messages" &&
      subId &&
      parts[4] === "callback"
    ) {
      const user = requireUser(body.user_id);
      return pressButton(requireChat(id), user, Number(subId), body.data);
    }
    if (
      resource === "chats" &&
      id &&
      sub === "guest-bot-reply" &&
      method === "POST"
    ) {
      // Guest mode (Bot API 10.0): a user calls a bot that is not a member of
      // the chat, and its answer is posted in the chat as that bot, with
      // guest_bot_caller_user naming the user who called it.
      const chat = requireChat(id);
      const caller = requireUser(body.caller_user_id);
      const username = String(body.bot_username ?? "").replace(/^@/, "");
      if (!/^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(username)) {
        throw new TelegramError(400, "guest bot needs a valid bot_username");
      }
      let guestBot = [...users.values()].find(
        (user) => user.is_bot && user.username === username,
      );
      if (!guestBot) {
        guestBot = {
          id: nextUserId++,
          is_bot: true,
          first_name: username,
          username,
          photos: [],
        };
        users.set(guestBot.id, guestBot);
      }
      const text = String(body.text ?? "");
      const entities = messageEntities(text);
      const message = addMessage(chat, guestBot, {
        text,
        ...(entities.length > 0 ? { entities } : {}),
        guest_bot_caller_user: userObject(caller),
      });
      await emit("message", message);
      return { message_id: message.message_id };
    }
    if (resource === "calls" && method === "GET") {
      return { calls, unimplemented: [...unimplemented] };
    }
    if (resource === "webhook" && method === "GET") return bot.webhook;
    throw new TelegramError(
      404,
      `Unknown fake control ${method} /${parts.join("/")}`,
    );
  }

  /**
   * The owner (or `by`) creates or renames a forum topic. Telegram posts a
   * service message for each, and a topic's id is its creation message's id.
   */
  async function topicControl(chat, method, threadId, action, body) {
    if (method === "GET" && !threadId) {
      return [...chat.topics.entries()].map(([id, topic]) => ({
        message_thread_id: id,
        name: topic.name,
      }));
    }
    const actor = requireUser(body.by ?? creatorOf(chat));
    const name = body.name == null ? null : String(body.name).trim();
    if (name !== null && (name === "" || name.length > 128)) {
      throw new TelegramError(400, "Bad Request: TOPIC_TITLE_EMPTY");
    }
    if (method === "POST" && !threadId) {
      if (name === null) {
        throw new TelegramError(400, "Bad Request: TOPIC_TITLE_EMPTY");
      }
      const message = addMessage(chat, actor, {
        forum_topic_created: { name, icon_color: 7322096 },
        is_topic_message: true,
      });
      message.message_thread_id = message.message_id;
      chat.topics.set(message.message_id, { name });
      await emit("message", message);
      return { message_thread_id: message.message_id, name };
    }
    if (method === "POST" && threadId && action === "edit") {
      const topic = chat.topics.get(Number(threadId));
      if (!topic) throw new TelegramError(400, "Bad Request: TOPIC_ID_INVALID");
      if (name !== null) topic.name = name;
      const message = addMessage(chat, actor, {
        forum_topic_edited: { name: topic.name },
        message_thread_id: Number(threadId),
        is_topic_message: true,
      });
      await emit("message", message);
      return { message_thread_id: Number(threadId), name: topic.name };
    }
    throw new TelegramError(404, `Unknown topic control ${method}`);
  }

  /**
   * A member presses an inline button: Telegram sends the bot a callback_query
   * and waits for its answer, which it hands back to the member.
   */
  async function pressButton(chat, user, messageId, data) {
    const entry = chat.messages.get(messageId);
    if (!entry || entry.deleted) {
      throw new TelegramError(400, "MESSAGE_ID_INVALID");
    }
    const buttons = entry.message.reply_markup?.inline_keyboard?.flat() ?? [];
    if (
      !buttons.some((button) => button.callback_data === String(data ?? ""))
    ) {
      throw new TelegramError(
        400,
        "The message has no button with that callback data",
      );
    }
    const queryId = randomBytes(8).readBigUInt64BE().toString();
    openQueries.add(queryId);
    // Only the bot that sent the message hears its buttons pressed.
    const sender = [...bots.values()].find(
      (record) => record.id === entry.message.from?.id,
    );
    await emit(
      "callback_query",
      {
        id: queryId,
        from: userObject(user),
        message: entry.message,
        chat_instance: String(chat.id),
        data: String(data ?? ""),
      },
      { to: sender ? [sender] : [bot] },
    );
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (callbackAnswers.has(queryId)) {
        const answer = callbackAnswers.get(queryId);
        callbackAnswers.delete(queryId);
        return { answered: true, ...answer };
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    openQueries.delete(queryId);
    return { answered: false };
  }

  async function join(chat, { user_id: userId, invite_link: link }) {
    const user = requireUser(userId);
    const current = memberStatus(chat, userId);
    if (current.status === "kicked") {
      throw new TelegramError(400, "USER_BANNED_IN_CHANNEL");
    }
    if (isInChat(chat, userId)) {
      throw new TelegramError(400, "USER_ALREADY_PARTICIPANT");
    }
    const invite = link ? chat.inviteLinks.get(link) : null;
    if (link && (!invite || invite.is_revoked)) {
      throw new TelegramError(400, "INVITE_HASH_EXPIRED");
    }
    if (invite?.creates_join_request) {
      chat.joinRequests.set(user.id, {
        invite_link: { ...invite },
        date: now(),
      });
      const request = {
        chat: chatObject(chat),
        from: userObject(user),
        user_chat_id: user.id,
        date: now(),
        ...(user.bio ? { bio: user.bio } : {}),
        invite_link: { ...invite },
      };
      // A guard bot in the chat gets the request as a query to answer.
      const guard = [...bots.values()].find(
        (record) => record.joinRequestQueries && isInChat(chat, record.id),
      );
      const others = [...bots.values()].filter(
        (record) => record !== guard && isInChat(chat, record.id),
      );
      if (guard) {
        const queryId = randomBytes(8).readBigUInt64BE().toString();
        joinQueries.set(queryId, {
          chatId: chat.id,
          userId: user.id,
          botId: guard.id,
        });
        await emit(
          "chat_join_request",
          { ...request, query_id: queryId },
          { to: [guard] },
        );
      }
      await emit("chat_join_request", request, { to: others });
      return { status: "requested" };
    }
    const before = chatMemberObject(chat, user.id);
    admit(chat, user.id);
    await emitMemberChange(chat, user.id, before, user, {
      ...(invite ? { invite_link: { ...invite } } : {}),
    });
    const service = addMessage(chat, user, {
      new_chat_members: [userObject(user)],
    });
    await emit("message", service);
    return { status: "member" };
  }

  async function leave(chat, { user_id: userId }) {
    const user = requireUser(userId);
    if (!isInChat(chat, userId))
      return { status: memberStatus(chat, userId).status };
    const before = chatMemberObject(chat, userId);
    const current = memberStatus(chat, userId);
    chat.members.set(
      user.id,
      current.status === "restricted"
        ? { ...current, is_member: false }
        : { status: "left" },
    );
    await emitMemberChange(chat, user.id, before, user);
    const service = addMessage(chat, user, {
      left_chat_member: userObject(user),
    });
    await emit("message", service);
    return { status: "left" };
  }

  /**
   * Where a member's forwarded message came from: a user, a user who hides
   * their account (a name only), or a channel post.
   */
  function forwardOrigin(from) {
    const date = now();
    if (from.chat_id != null) {
      const source = requireChat(from.chat_id);
      if (source.type !== "channel") {
        throw new TelegramError(400, "forward_from.chat_id must be a channel");
      }
      const original =
        from.message_id != null
          ? source.messages.get(Number(from.message_id))
          : null;
      return {
        type: "channel",
        chat: chatObject(source),
        message_id: Number(from.message_id ?? 1),
        date: original?.message.date ?? date,
      };
    }
    if (from.user_id != null) {
      return {
        type: "user",
        sender_user: userObject(requireUser(from.user_id)),
        date,
      };
    }
    if (from.sender_name) {
      return {
        type: "hidden_user",
        sender_user_name: String(from.sender_name),
        date,
      };
    }
    throw new TelegramError(
      400,
      "forward_from needs user_id, sender_name, or a channel chat_id",
    );
  }

  /** A member posts 2 to 10 photos or videos as one album. */
  async function postAlbum(
    chat,
    { user_id: userId, items, message_thread_id },
  ) {
    if (!Array.isArray(items) || items.length < 2 || items.length > 10) {
      throw new TelegramError(400, "an album needs 2 to 10 items");
    }
    const mediaGroupId = String(nextMediaGroupId++);
    const ids = [];
    for (const item of items) {
      if (!["photo", "video"].includes(item?.type)) {
        throw new TelegramError(400, "album items are photos or videos");
      }
      const { message_id: id } = await post(
        chat,
        {
          user_id: userId,
          media: { type: item.type, base64: item.base64 },
          caption: item.caption,
          message_thread_id,
        },
        { mediaGroupId },
      );
      ids.push(id);
    }
    return { media_group_id: mediaGroupId, message_ids: ids };
  }

  /**
   * The author edits their message: the bots in the chat get edited_message
   * with the whole message and its edit_date.
   */
  async function editByMember(
    chat,
    messageId,
    { user_id: userId, text, caption },
  ) {
    const entry = chat.messages.get(Number(messageId));
    if (!entry || entry.deleted) {
      throw new TelegramError(400, "MESSAGE_ID_INVALID");
    }
    if (entry.message.from?.id !== Number(userId)) {
      throw new TelegramError(403, "MESSAGE_AUTHOR_REQUIRED");
    }
    const message = entry.message;
    const field = message.text !== undefined ? "text" : "caption";
    const value = field === "text" ? text : caption;
    if (value === undefined || value === null) {
      throw new TelegramError(400, `the edit needs ${field}`);
    }
    if (String(value) === (message[field] ?? "")) {
      throw new TelegramError(400, "MESSAGE_NOT_MODIFIED");
    }
    message[field] = String(value);
    const entities = messageEntities(message[field]);
    const entityField = field === "text" ? "entities" : "caption_entities";
    if (entities.length > 0) message[entityField] = entities;
    else delete message[entityField];
    message.edit_date = now();
    await emit("edited_message", structuredClone(message));
    return { message_id: message.message_id, edit_date: message.edit_date };
  }

  /**
   * A member sets their reaction on a message (one emoji, or none to take it
   * back). Telegram tells the chat's administrator bots through
   * message_reaction, when they asked for it in allowed_updates.
   */
  async function reactByMember(chat, messageId, { user_id: userId, emoji }) {
    const user = requireUser(userId);
    const entry = chat.messages.get(Number(messageId));
    if (!entry || entry.deleted) {
      throw new TelegramError(400, "MESSAGE_ID_INVALID");
    }
    if (!isInChat(chat, user.id)) {
      throw new TelegramError(403, "CHAT_WRITE_FORBIDDEN");
    }
    return changeReaction(chat, entry, user, emoji ? [String(emoji)] : []);
  }

  function reactionList(emojis) {
    return emojis.map((emoji) => ({ type: "emoji", emoji }));
  }

  async function changeReaction(chat, entry, user, emojis) {
    entry.reactions ??= new Map();
    const before = entry.reactions.get(user.id) ?? [];
    if (emojis.length) entry.reactions.set(user.id, emojis);
    else entry.reactions.delete(user.id);
    const admins = [...bots.values()].filter((record) =>
      ["administrator", "creator"].includes(
        memberStatus(chat, record.id).status,
      ),
    );
    await emit(
      "message_reaction",
      {
        chat: chatObject(chat),
        message_id: entry.message.message_id,
        user: userObject(user),
        date: now(),
        old_reaction: reactionList(before),
        new_reaction: reactionList(emojis),
      },
      { to: admins },
    );
    return { reactions: Object.fromEntries(entry.reactions) };
  }

  async function post(
    chat,
    {
      user_id: userId,
      text,
      photo_base64: photoBase64,
      media,
      caption,
      reply_to: replyTo,
      message_thread_id: threadId,
      forward_from: forwardFrom,
    },
    { mediaGroupId = null } = {},
  ) {
    const user = requireUser(userId);
    requireTopic(chat, threadId);
    const type = photoBase64 ? "photo" : (media?.type ?? null);
    if (type && type !== "photo" && !MEMBER_MEDIA[type]) {
      throw new TelegramError(
        400,
        `media type must be photo or one of ${Object.keys(MEMBER_MEDIA).join(", ")}`,
      );
    }
    const permission =
      type === "photo"
        ? "can_send_photos"
        : type
          ? MEMBER_MEDIA[type].permission
          : "can_send_messages";
    if (chat.type !== "private" && !canPost(chat, userId, permission)) {
      throw new TelegramError(403, "CHAT_WRITE_FORBIDDEN");
    }
    const fields = {};
    if (type) {
      const bytes = Buffer.from(photoBase64 ?? media.base64 ?? "", "base64");
      const file =
        type === "photo"
          ? registerPhoto(bytes)
          : registerFile(bytes, `${type}s`, MEMBER_MEDIA[type].ext);
      Object.assign(
        fields,
        mediaFields(type, file, {
          fileName: media?.file_name,
          mimeType: media?.mime_type,
          duration: media?.duration,
        }),
      );
      if (caption && (type === "photo" || MEMBER_MEDIA[type].caption)) {
        fields.caption = String(caption);
        const captionEntities = messageEntities(fields.caption);
        if (captionEntities.length > 0)
          fields.caption_entities = captionEntities;
      }
    } else {
      fields.text = String(text ?? "");
    }
    if (mediaGroupId) fields.media_group_id = mediaGroupId;
    if (forwardFrom) fields.forward_origin = forwardOrigin(forwardFrom);
    // A message in a topic that answers nothing replies to the topic's
    // creation message, which is how a bot learns the topic's name.
    const replied =
      replyTo != null
        ? chat.messages.get(Number(replyTo))
        : threadId
          ? chat.messages.get(Number(threadId))
          : null;
    if (replied) {
      const { reply_to_message: _nested, ...original } = replied.message;
      fields.reply_to_message = original;
    }
    if (threadId && chat.topics) {
      fields.message_thread_id = Number(threadId);
      fields.is_topic_message = true;
    }
    if (fields.text) {
      const entities = messageEntities(fields.text);
      if (entities.length > 0) fields.entities = entities;
    }
    const message = addMessage(chat, user, fields);
    await emit("message", message);
    return { message_id: message.message_id };
  }

  // ── HTTP ───────────────────────────────────────────────────────────────
  // ── Telegram Login (OpenID Connect) ────────────────────────────────────
  // The code flow at oauth.telegram.org, as documented at
  // https://core.telegram.org/bots/telegram-login and in its discovery
  // document, https://oauth.telegram.org/.well-known/openid-configuration.
  const LOGIN_ISSUER = "https://oauth.telegram.org";
  // UNVERIFIED: how long Telegram keeps an unused code; OAuth recommends a
  // short life (RFC 6749 §4.1.2).
  const LOGIN_CODE_TTL_MS = 60_000;
  // The documented token response says "expires_in": 3600.
  const LOGIN_TOKEN_TTL_S = 3600;
  const loginKey = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const loginKid = `fake-${randomBytes(6).toString("hex")}`;
  const loginCodes = new Map();
  // `sub` is an opaque id, not the Telegram id (the documented example has a
  // different sub and id); it is stable for a user ("public" subject type).
  const subjectSalt = randomBytes(16);

  function loginSubject(userId) {
    const digest = createHash("sha256")
      .update(subjectSalt)
      .update(String(userId))
      .digest();
    return (digest.readBigUInt64BE(0) % 10n ** 19n).toString();
  }

  function base64url(value) {
    return Buffer.from(value).toString("base64url");
  }

  function signIdToken(claims) {
    const header = { alg: "RS256", typ: "JWT", kid: loginKid };
    const input = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
    const signature = sign("sha256", Buffer.from(input), loginKey.privateKey);
    return `${input}.${signature.toString("base64url")}`;
  }

  function discoveryDocument() {
    return {
      issuer: LOGIN_ISSUER,
      authorization_endpoint: `${origin}/auth`,
      token_endpoint: `${origin}/token`,
      jwks_uri: `${origin}/.well-known/jwks.json`,
      response_types_supported: ["code"],
      token_endpoint_auth_methods_supported: [
        "client_secret_basic",
        "client_secret_post",
      ],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256"],
      scopes_supported: ["openid", "phone", "profile", "telegram:bot_access"],
      claims_supported: [
        "aud",
        "preferred_username",
        "phone_number",
        "exp",
        "iat",
        "iss",
        "name",
        "picture",
        "sub",
      ],
      code_challenge_methods_supported: ["plain", "S256"],
      grant_types_supported: ["authorization_code"],
    };
  }

  function jwks() {
    return {
      keys: [
        {
          ...loginKey.publicKey.export({ format: "jwk" }),
          alg: "RS256",
          use: "sig",
          kid: loginKid,
        },
      ],
    };
  }

  function loginRedirect(redirectUri, params) {
    const url = new URL(redirectUri);
    for (const [key, value] of Object.entries(params)) {
      if (value != null) url.searchParams.set(key, value);
    }
    return url.toString();
  }

  /**
   * A /auth request, checked. The docs make openid required and PKCE
   * recommended; the discovery document lists "plain" and "S256".
   */
  function loginRequest(query) {
    const clientId = String(query.get("client_id") ?? "");
    const record = [...bots.values()].find(
      (entry) => String(entry.id) === clientId,
    );
    if (!record) return { error: "unknown client_id" };
    const redirectUri = query.get("redirect_uri") ?? "";
    try {
      new URL(redirectUri);
    } catch {
      return { error: "redirect_uri must be an absolute URL" };
    }
    if (query.get("response_type") !== "code") {
      return { error: 'response_type must be "code"' };
    }
    const scopes = String(query.get("scope") ?? "")
      .split(/\s+/)
      .filter(Boolean);
    if (!scopes.includes("openid")) {
      return { error: 'scope must include "openid"' };
    }
    const challenge = query.get("code_challenge");
    const method =
      query.get("code_challenge_method") ?? (challenge ? "plain" : null);
    if (challenge && method !== "S256" && method !== "plain") {
      return { error: 'code_challenge_method must be "S256" or "plain"' };
    }
    if (!challenge && query.get("code_challenge_method")) {
      return { error: "code_challenge_method without code_challenge" };
    }
    return {
      bot: record,
      redirectUri,
      scopes,
      state: query.get("state"),
      nonce: query.get("nonce"),
      challenge,
      method,
    };
  }

  /** The user allows the login: a one-time code goes back to redirect_uri. */
  function approveLogin(request, user) {
    if (user.is_bot) throw new TelegramError(400, "a bot cannot log in");
    const code = randomBytes(24).toString("base64url");
    loginCodes.set(code, {
      ...request,
      userId: user.id,
      expiresAt: Date.now() + LOGIN_CODE_TTL_MS,
      used: false,
    });
    return loginRedirect(request.redirectUri, { code, state: request.state });
  }

  function escapeHtml(value) {
    return String(value).replace(
      /[&<>"']/g,
      (character) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[character],
    );
  }

  /** The login page: one button per fake user, and Cancel. */
  function loginPage(url, request) {
    const action = escapeHtml(`/auth${url.search}`);
    const people = [...users.values()].filter((user) => !user.is_bot);
    const buttons = people
      .map(
        (user) =>
          `<form method="post" action="${action}"><input type="hidden" name="user_id" value="${user.id}"><button>Log in as ${escapeHtml(
            [user.first_name, user.last_name].filter(Boolean).join(" "),
          )}</button></form>`,
      )
      .join("\n");
    return `<!doctype html><html><head><meta charset="utf-8"><title>Log in to ${escapeHtml(
      request.bot.first_name,
    )}</title></head><body><h1>Log in to ${escapeHtml(request.bot.first_name)}</h1>
${buttons}
<form method="post" action="${action}"><input type="hidden" name="cancel" value="1"><button>Cancel</button></form>
</body></html>`;
  }

  function sendOAuthError(response, status, error, description, headers = {}) {
    response.writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...headers,
    });
    response.end(JSON.stringify({ error, error_description: description }));
  }

  /**
   * POST /token: the code for an ID token, with the client authenticated by
   * HTTP Basic as the docs show (client_secret_post is listed too), and the
   * PKCE verifier checked against the challenge (RFC 7636).
   */
  function exchangeCode(request, body, response) {
    const form = new URLSearchParams(body.toString("utf8"));
    let clientId = form.get("client_id");
    let secret = form.get("client_secret");
    const basic = String(request.headers.authorization ?? "").match(
      /^Basic\s+(.+)$/i,
    );
    if (basic) {
      const decoded = Buffer.from(basic[1], "base64").toString("utf8");
      const colon = decoded.indexOf(":");
      clientId = decodeURIComponent(decoded.slice(0, colon));
      secret = decodeURIComponent(decoded.slice(colon + 1));
    }
    const record = [...bots.values()].find(
      (entry) => String(entry.id) === String(clientId ?? ""),
    );
    const expected = Buffer.from(record?.loginClientSecret ?? "");
    const given = Buffer.from(String(secret ?? ""));
    if (
      !record ||
      expected.length !== given.length ||
      !timingSafeEqual(expected, given)
    ) {
      sendOAuthError(
        response,
        401,
        "invalid_client",
        "Client authentication failed",
        {
          "WWW-Authenticate": 'Basic realm="oauth.telegram.org"',
        },
      );
      return;
    }
    if (form.get("grant_type") !== "authorization_code") {
      sendOAuthError(
        response,
        400,
        "unsupported_grant_type",
        'grant_type must be "authorization_code"',
      );
      return;
    }
    const code = loginCodes.get(String(form.get("code") ?? ""));
    const invalid = (description) =>
      sendOAuthError(response, 400, "invalid_grant", description);
    if (!code || code.bot.id !== record.id) return invalid("Unknown code");
    if (code.used) return invalid("The code was already used");
    code.used = true;
    if (Date.now() > code.expiresAt) return invalid("The code has expired");
    if (form.get("redirect_uri") !== code.redirectUri) {
      return invalid("redirect_uri does not match the authorization request");
    }
    if (code.challenge) {
      const verifier = String(form.get("code_verifier") ?? "");
      const derived =
        code.method === "S256"
          ? createHash("sha256").update(verifier).digest("base64url")
          : verifier;
      if (!verifier || derived !== code.challenge) {
        return invalid("code_verifier does not match the code_challenge");
      }
    }
    const user = requireUser(code.userId);
    const issuedAt = Math.floor(Date.now() / 1000);
    const claims = {
      iss: LOGIN_ISSUER,
      aud: String(record.id),
      sub: loginSubject(user.id),
      iat: issuedAt,
      exp: issuedAt + LOGIN_TOKEN_TTL_S,
      ...(code.nonce ? { nonce: code.nonce } : {}),
    };
    // The profile scope adds the user's id, name, username and photo.
    if (code.scopes.includes("profile")) {
      Object.assign(claims, {
        id: user.id,
        name: [user.first_name, user.last_name].filter(Boolean).join(" "),
        given_name: user.first_name,
        ...(user.last_name ? { family_name: user.last_name } : {}),
        ...(user.username ? { preferred_username: user.username } : {}),
        ...(user.photos?.length
          ? { picture: `${origin}/userpic/${user.id}.jpg` }
          : {}),
      });
    }
    // telegram:bot_access "allows your bot to send direct messages to the
    // user after login".
    if (code.scopes.includes("telegram:bot_access")) {
      const chat = messageChat(user.id);
      chat.openTo ??= new Set();
      chat.openTo.add(record.id);
    }
    response.writeHead(200, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    response.end(
      JSON.stringify({
        access_token: randomBytes(24).toString("base64url"),
        token_type: "Bearer",
        expires_in: LOGIN_TOKEN_TTL_S,
        id_token: signIdToken(claims),
      }),
    );
  }

  /** The login routes, at oauth.telegram.org's paths; false when not one. */
  function serveLogin(request, url, body, response) {
    const path = url.pathname;
    if (
      path === "/.well-known/openid-configuration" &&
      request.method === "GET"
    ) {
      send(response, 200, discoveryDocument());
      return true;
    }
    if (path === "/.well-known/jwks.json" && request.method === "GET") {
      send(response, 200, jwks());
      return true;
    }
    if (path === "/token" && request.method === "POST") {
      exchangeCode(request, body, response);
      return true;
    }
    const picture = path.match(/^\/userpic\/(\d+)\.jpg$/);
    if (picture && request.method === "GET") {
      const file = files.get(
        users.get(Number(picture[1]))?.photos?.[0]?.file_id,
      );
      if (!file) {
        response.writeHead(404).end();
        return true;
      }
      response.writeHead(200, { "Content-Type": "image/jpeg" });
      response.end(file.data);
      return true;
    }
    if (path !== "/auth" || !["GET", "POST"].includes(request.method)) {
      return false;
    }
    const loginQuery = loginRequest(url.searchParams);
    if (loginQuery.error) {
      // An unverified client or redirect_uri is never redirected to
      // (RFC 6749 §4.1.2.1); the page reports the problem instead.
      response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      response.end(`Login refused: ${loginQuery.error}`);
      return true;
    }
    if (request.method === "GET") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(loginPage(url, loginQuery));
      return true;
    }
    const form = new URLSearchParams(body.toString("utf8"));
    let location;
    if (form.get("cancel")) {
      location = loginRedirect(loginQuery.redirectUri, {
        error: "access_denied",
        state: loginQuery.state,
      });
    } else {
      const user = users.get(Number(form.get("user_id")));
      if (!user || user.is_bot) {
        response.writeHead(400, {
          "Content-Type": "text/plain; charset=utf-8",
        });
        response.end("Login refused: unknown user");
        return true;
      }
      location = approveLogin(loginQuery, user);
    }
    response.writeHead(302, { Location: location });
    response.end();
    return true;
  }

  function send(response, status, payload) {
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(payload));
  }

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://localhost");
      const body = await readBody(request);
      if (url.pathname.startsWith("/_fake/")) {
        const parts = url.pathname
          .slice("/_fake/".length)
          .split("/")
          .filter(Boolean);
        try {
          const payload = body.length ? parseJsonObject(body) : {};
          send(response, 200, await control(request.method, parts, payload));
        } catch (error) {
          if (!(error instanceof TelegramError)) throw error;
          send(response, error.code, { error: error.message });
        }
        return;
      }
      const ownerCall = url.pathname.match(/^\/_owner\/([^/]+)\/([A-Za-z]+)$/);
      if (ownerCall && request.method === "POST") {
        const args = body.length ? parseJsonObject(body) : {};
        const answer = await ownerModel.rpc(
          decodeURIComponent(ownerCall[1]),
          ownerCall[2],
          args,
        );
        // A dropped response: the call ran, and the connection closes unanswered.
        if (answer.drop) {
          request.socket.destroy();
          return;
        }
        send(response, answer.status, answer.body);
        return;
      }
      if (serveLogin(request, url, body, response)) return;
      const file = url.pathname.match(/^\/file\/bot([^/]+)\/(.+)$/);
      if (file) {
        const entry = [...files.values()].find((f) => f.file_path === file[2]);
        if (!entry || !bots.has(file[1])) {
          response.writeHead(404).end();
          return;
        }
        response.writeHead(200, {
          "Content-Type": entry.file_path.startsWith("photos/")
            ? "image/jpeg"
            : "application/octet-stream",
        });
        response.end(entry.data);
        return;
      }
      const call = url.pathname.match(/^\/bot([^/]+)\/([A-Za-z]+)$/);
      if (!call) {
        send(response, 404, {
          ok: false,
          error_code: 404,
          description: "Not Found",
        });
        return;
      }
      const caller = bots.get(call[1]);
      if (!caller) {
        send(response, 401, {
          ok: false,
          error_code: 401,
          description: "Unauthorized",
        });
        return;
      }
      const method = call[2];
      let params;
      try {
        params = await readRequestParams(request, body);
      } catch (error) {
        if (!(error instanceof TelegramError)) throw error;
        send(response, error.code, {
          ok: false,
          error_code: error.code,
          description: error.message,
        });
        return;
      }
      // A basic group upgraded to a supergroup answers every call with the new
      // id in ResponseParameters.migrate_to_chat_id.
      // https://core.telegram.org/bots/api#responseparameters
      const addressed = chats.get(Number(params.chat_id));
      if (addressed?.migratedTo != null) {
        calls.push({
          method,
          bot_id: caller.id,
          params: summarize(params),
          at: Date.now(),
          failed: 400,
        });
        send(response, 400, {
          ok: false,
          error_code: 400,
          description:
            "Bad Request: group chat was upgraded to a supergroup chat",
          parameters: { migrate_to_chat_id: addressed.migratedTo },
        });
        return;
      }
      const failure = takeFailure(method, caller, params);
      calls.push({
        method,
        bot_id: caller.id,
        params: summarize(params),
        at: Date.now(),
        ...(failure
          ? failure.drop_after_apply
            ? { dropped: true }
            : { failed: failure.error_code }
          : {}),
      });
      if (failure && !failure.drop_after_apply) {
        send(response, failure.error_code, {
          ok: false,
          error_code: failure.error_code,
          description: failure.description,
          ...(failure.retry_after != null
            ? { parameters: { retry_after: failure.retry_after } }
            : {}),
        });
        return;
      }
      // Bot API method names are case-insensitive.
      const handler = methodsByLowerName.get(method.toLowerCase());
      if (!handler) {
        if (!unimplemented.has(method)) {
          unimplemented.add(method);
          log(`unimplemented Bot API method ${method}`);
        }
        if (unimplementedMode === "ok") {
          send(response, 200, { ok: true, result: true });
        } else {
          // Real Telegram's answer to a method it does not know, with a
          // description that says this fake is the one missing it.
          send(response, 404, {
            ok: false,
            error_code: 404,
            description: `Not Found: method ${method} is not implemented by telegram-bot-test-server`,
          });
        }
        return;
      }
      try {
        const result = await handler(params, caller);
        // The call took effect, but its answer is lost on the way back.
        if (failure?.drop_after_apply) {
          request.socket.destroy();
          return;
        }
        send(response, 200, { ok: true, result });
      } catch (error) {
        if (!(error instanceof TelegramError)) throw error;
        send(response, error.code, {
          ok: false,
          error_code: error.code,
          description: error.message,
          ...(error.parameters ? { parameters: error.parameters } : {}),
        });
      }
    } catch (error) {
      log(`internal error: ${error.stack ?? error.message}`);
      send(response, 500, {
        ok: false,
        error_code: 500,
        description: error.message,
      });
    }
  });

  function takeFailure(method, caller, params) {
    const index = failures.findIndex(
      (rule) =>
        rule.method.toLowerCase() === method.toLowerCase() &&
        (rule.chat_id === null || rule.chat_id === String(params.chat_id)) &&
        (rule.bot_id === null || rule.bot_id === caller.id),
    );
    if (index < 0) return null;
    const rule = failures[index];
    rule.remaining -= 1;
    if (rule.remaining <= 0) failures.splice(index, 1);
    return rule;
  }

  function summarize(params) {
    const out = {};
    for (const [key, value] of Object.entries(params)) {
      out[key] = Buffer.isBuffer(value) ? `<${value.length} bytes>` : value;
    }
    return out;
  }

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  const origin = `http://${host.includes(":") ? `[${host}]` : host}:${address.port}`;
  /** Run a control action in-process, with the same checks as /_fake/*. */
  async function act(method, path, body = {}) {
    try {
      return await control(method, path.split("/"), body);
    } catch (error) {
      if (error instanceof TelegramError) throw new Error(error.message);
      throw error;
    }
  }
  const inviteHash = (link) =>
    encodeURIComponent(link.replace(/^https:\/\/t\.me\/\+/, ""));

  return {
    origin,
    addBot: ({ token, username, firstName, supportsJoinRequestQueries } = {}) =>
      act("POST", "bots", {
        token,
        username,
        first_name: firstName,
        supports_join_request_queries: supportsJoinRequestQueries === true,
      }),
    createChat: async ({ title, type, ownerId, ownerName, isForum } = {}) =>
      (
        await act("POST", "chats", {
          title,
          type,
          owner_id: ownerId,
          owner_name: ownerName,
          is_forum: isForum,
        })
      ).id,
    getChat: (chatId) => act("GET", `chats/${chatId}`),
    addBotViaLink: (chatId, botId, { by, startParameter, rights } = {}) =>
      act("POST", `chats/${chatId}/bots`, {
        bot_id: botId,
        start_parameter: startParameter ?? "",
        ...(by != null ? { by } : {}),
        ...(rights ? { rights } : {}),
      }),
    migrateToSupergroup: async (chatId, { by } = {}) =>
      (await act("POST", `chats/${chatId}/migrate`, by != null ? { by } : {}))
        .id,
    renameChat: (chatId, { by, title } = {}) =>
      act("POST", `chats/${chatId}/title`, { by, title }),
    changeChatPhoto: (chatId, { by, bytes } = {}) =>
      act("POST", `chats/${chatId}/photo`, {
        by,
        base64: Buffer.from(bytes ?? []).toString("base64"),
      }),
    setBotMembership: (chatId, botId, { status, rights, by } = {}) =>
      act("POST", `chats/${chatId}/bots`, {
        bot_id: botId,
        status,
        rights,
        by,
      }),
    createTopic: async (chatId, name, { by } = {}) =>
      (await act("POST", `chats/${chatId}/topics`, { name, by }))
        .message_thread_id,
    renameTopic: (chatId, threadId, name, { by } = {}) =>
      act("POST", `chats/${chatId}/topics/${threadId}/edit`, { name, by }),
    failNext: (rule) =>
      act("POST", "failures", {
        method: rule.method,
        chat_id: rule.chatId,
        bot_id: rule.botId,
        times: rule.times,
        error_code: rule.errorCode,
        description: rule.description,
        retry_after: rule.retryAfter,
        drop_after_apply: rule.dropAfterApply === true,
      }),
    clearFailures: () => act("DELETE", "failures"),
    createUser: async (fields = {}) => (await act("POST", "users", fields)).id,
    createOwner: ({ userId, firstName, lastName, username } = {}) =>
      act("POST", "owners", {
        user_id: userId,
        first_name: firstName,
        last_name: lastName,
        username,
      }),
    updateOwner: (ownerId, { authorized } = {}) =>
      act("POST", `owners/${ownerId}`, { authorized }),
    getOwner: (ownerId) => act("GET", `owners/${ownerId}`),
    addOwnerUser: (ownerId, { id, firstName, lastName, username, bot } = {}) =>
      act("POST", `owners/${ownerId}/users`, {
        id,
        first_name: firstName,
        last_name: lastName,
        username,
        bot,
      }),
    addOwnerDialog: (ownerId, fields = {}) =>
      act("POST", `owners/${ownerId}/dialogs`, {
        kind: fields.kind,
        id: fields.id,
        title: fields.title,
        first_name: fields.firstName,
        last_name: fields.lastName,
        username: fields.username,
        participants_count: fields.participantsCount,
        folder: fields.folder,
        pinned: fields.pinned,
        muted: fields.muted,
        mute_until: fields.muteUntil,
        unread_count: fields.unreadCount,
        date: fields.date,
      }),
    updateOwnerDialog: (ownerId, peerId, fields = {}) =>
      act("POST", `owners/${ownerId}/dialogs/${peerId}`, {
        folder: fields.folder,
        pinned: fields.pinned,
        muted: fields.muted,
        mute_until: fields.muteUntil,
        unread_count: fields.unreadCount,
      }),
    addOwnerMessages: (ownerId, peerId, messages) =>
      act("POST", `owners/${ownerId}/dialogs/${peerId}/messages`, {
        messages: messages.map((message) => ({
          id: message.id,
          date: message.date,
          from_id: message.fromId,
          out: message.out,
          text: message.text,
          action: message.action,
          reply_to: message.replyTo,
          media: message.media,
          edit_date: message.editDate,
        })),
      }),
    editOwnerMessage: (ownerId, peerId, messageId, { text, editDate } = {}) =>
      act("POST", `owners/${ownerId}/dialogs/${peerId}/messages/${messageId}`, {
        text,
        edit_date: editDate,
      }),
    deleteOwnerMessage: (ownerId, peerId, messageId) =>
      act(
        "DELETE",
        `owners/${ownerId}/dialogs/${peerId}/messages/${messageId}`,
      ),
    setOwnerFilter: (ownerId, filter) =>
      act("POST", `owners/${ownerId}/filters`, {
        id: filter.id,
        title: filter.title,
        emoticon: filter.emoticon,
        color: filter.color,
        include_peers: filter.includePeers,
        exclude_peers: filter.excludePeers,
        pinned_peers: filter.pinnedPeers,
        contacts: filter.contacts,
        non_contacts: filter.nonContacts,
        groups: filter.groups,
        broadcasts: filter.broadcasts,
        bots: filter.bots,
        exclude_muted: filter.excludeMuted,
        exclude_read: filter.excludeRead,
        exclude_archived: filter.excludeArchived,
      }),
    orderOwnerFilters: (ownerId, ids) =>
      act("POST", `owners/${ownerId}/filters/order`, { ids }),
    deleteOwnerFilter: (ownerId, filterId) =>
      act("DELETE", `owners/${ownerId}/filters/${filterId}`),
    failOwnerCall: (ownerId, fault) =>
      act("POST", `owners/${ownerId}/faults`, {
        method: fault.method,
        peer_id: fault.peerId,
        times: fault.times,
        delay_ms: fault.delayMs,
        preset: fault.preset,
        seconds: fault.seconds,
        error_message: fault.errorMessage,
        code: fault.code,
      }),
    clearOwnerFaults: (ownerId) => act("DELETE", `owners/${ownerId}/faults`),
    getOwnerCalls: (ownerId) => act("GET", `owners/${ownerId}/calls`),
    resetOwners: () => act("DELETE", "owners"),
    approveLogin: async (authUrl, userId) =>
      (
        await act("POST", "login/approve", {
          auth_url: authUrl,
          user_id: userId,
        })
      ).redirect_url,
    cancelLogin: async (authUrl) =>
      (await act("POST", "login/cancel", { auth_url: authUrl })).redirect_url,
    connectBusiness: ({ ownerId, rights, id, isEnabled, botId } = {}) =>
      act("POST", "business/connections", {
        owner_id: ownerId,
        rights,
        ...(id != null ? { id } : {}),
        ...(isEnabled !== undefined ? { is_enabled: isEnabled } : {}),
        ...(botId != null ? { bot_id: botId } : {}),
      }),
    getBusinessConnection: (connectionId) =>
      act("GET", `business/connections/${connectionId}`),
    sayInBusinessChat: (connectionId, userId, sender, text) =>
      act(
        "POST",
        `business/connections/${connectionId}/chats/${userId}/messages`,
        { sender, text },
      ),
    getBusinessChat: (connectionId, userId) =>
      act(
        "GET",
        `business/connections/${connectionId}/chats/${userId}/messages`,
      ),
    redeliverUpdate: (updateId) => act("POST", `updates/${updateId}/redeliver`),
    updateProfile: (userId, fields) =>
      act("POST", `users/${userId}/profile`, fields),
    addProfilePhoto: (userId, bytes) =>
      act("POST", `users/${userId}/photos`, {
        base64: Buffer.from(bytes).toString("base64"),
      }),
    join: (chatId, userId) =>
      act("POST", `chats/${chatId}/join`, { user_id: userId }),
    joinByLink: (inviteLink, userId) =>
      act("POST", `invites/${inviteHash(inviteLink)}/join`, {
        user_id: userId,
      }),
    leave: (chatId, userId) =>
      act("POST", `chats/${chatId}/leave`, { user_id: userId }),
    post: async (chatId, userId, message) => {
      const fields = postedMessageBody(message);
      return (
        await act("POST", `chats/${chatId}/messages`, {
          user_id: userId,
          ...fields,
        })
      ).message_id;
    },
    postAlbum: async (chatId, userId, items, { threadId } = {}) =>
      act("POST", `chats/${chatId}/albums`, {
        user_id: userId,
        items: items.map((item) => ({
          type: item.type,
          base64: Buffer.from(item.bytes ?? []).toString("base64"),
          ...(item.caption ? { caption: item.caption } : {}),
        })),
        ...(threadId != null ? { message_thread_id: threadId } : {}),
      }),
    editMessage: (chatId, messageId, userId, { text, caption } = {}) =>
      act("POST", `chats/${chatId}/messages/${messageId}/edit`, {
        user_id: userId,
        text,
        caption,
      }),
    react: (chatId, messageId, userId, emoji = null) =>
      act("POST", `chats/${chatId}/messages/${messageId}/reactions`, {
        user_id: userId,
        emoji,
      }),
    pressButton: (chatId, messageId, userId, data) =>
      act("POST", `chats/${chatId}/messages/${messageId}/callback`, {
        user_id: userId,
        data,
      }),
    sendDirectMessage: async (userId, message) =>
      (await act("POST", `users/${userId}/dm`, postedMessageBody(message)))
        .message_id,
    postGuestBotReply: async (chatId, callerUserId, botUsername, text) =>
      (
        await act("POST", `chats/${chatId}/guest-bot-reply`, {
          caller_user_id: callerUserId,
          bot_username: botUsername,
          text,
        })
      ).message_id,
    pressDirectButton: (userId, messageId, data) =>
      act("POST", `users/${userId}/dm/${messageId}/callback`, { data }),
    getMessages: (chatId) => act("GET", `chats/${chatId}/messages`),
    getMessage: (chatId, messageId) =>
      act("GET", `chats/${chatId}/messages/${messageId}`),
    getDirectMessages: (userId) => act("GET", `users/${userId}/dm`),
    getMember: (chatId, userId) =>
      act("GET", `chats/${chatId}/members/${userId}`),
    getJoinRequests: (chatId) => act("GET", `chats/${chatId}/join-requests`),
    getCalls: () => act("GET", "calls"),
    stop: () =>
      new Promise((resolve) => {
        for (const record of bots.values()) wakePollers(record);
        for (const abort of inFlight) abort.abort();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

export { createOwnerClient, ownerApi } from "./owner-client.js";
