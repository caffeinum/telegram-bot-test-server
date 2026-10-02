// parse_mode, explicit entities, replies and uploaded file names on bot sends,
// as the Bot API documents them.
import { afterEach, describe, expect, it } from "vitest";

import { startTestServer } from "../src/index.js";
import {
  parseHtml,
  parseMarkdown,
  parseMarkdownV2,
} from "../src/formatting.js";

const TOKEN = "123456:TEST";
const GROUP = -1001000000001;
const OWNER = 5000000001;

const cleanups = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

async function setup() {
  const server = await startTestServer({
    botToken: TOKEN,
    chats: [{ id: GROUP, title: "Test Group", ownerId: OWNER }],
  });
  cleanups.push(() => server.stop());
  async function api(method, params = {}) {
    const response = await fetch(`${server.origin}/bot${TOKEN}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });
    return { status: response.status, ...(await response.json()) };
  }
  return { server, api };
}

describe("HTML", () => {
  it("turns tags into entities with UTF-16 offsets", () => {
    expect(
      parseHtml(
        '<b>bold <i>both</i></b> &lt;x&gt; 😀<a href="https://e.com">link</a> <code>c</code>',
      ),
    ).toEqual({
      text: "bold both <x> 😀link c",
      entities: [
        { type: "bold", offset: 0, length: 9 },
        { type: "italic", offset: 5, length: 4 },
        { type: "text_link", offset: 16, length: 4, url: "https://e.com" },
        { type: "code", offset: 21, length: 1 },
      ],
    });
  });

  it("reads pre languages, spoilers, mentions, custom emoji and blockquotes", () => {
    expect(
      parseHtml(
        '<pre><code class="language-js">x()</code></pre><span class="tg-spoiler">s</span>' +
          '<a href="tg://user?id=42">u</a><tg-emoji emoji-id="5368324170671202286">👍</tg-emoji>' +
          "<blockquote expandable>q</blockquote>",
      ).entities,
    ).toEqual([
      { type: "pre", offset: 0, length: 3, language: "js" },
      { type: "spoiler", offset: 3, length: 1 },
      { type: "text_mention", offset: 4, length: 1, user: { id: 42 } },
      {
        type: "custom_emoji",
        offset: 5,
        length: 2,
        custom_emoji_id: "5368324170671202286",
      },
      { type: "expandable_blockquote", offset: 7, length: 1 },
    ]);
  });

  it("rejects markup Telegram rejects", () => {
    expect(() => parseHtml("<b>open")).toThrow(
      `can't parse entities: Can't find end tag corresponding to start tag "b"`,
    );
    expect(() => parseHtml("<b>x</i>")).toThrow("Unmatched end tag");
    expect(() => parseHtml("<div>x</div>")).toThrow(
      'Unsupported start tag "div" at byte offset 0',
    );
  });
});

describe("MarkdownV2", () => {
  it("parses nested styles, links, code and escapes", () => {
    expect(
      parseMarkdownV2(
        "*bold _italic_* __u__ ~s~ ||sp|| [l](https://e.com/a\\)b) `c\\`d` 1\\.5",
      ),
    ).toEqual({
      text: "bold italic u s sp l c`d 1.5",
      entities: [
        { type: "bold", offset: 0, length: 11 },
        { type: "italic", offset: 5, length: 6 },
        { type: "underline", offset: 12, length: 1 },
        { type: "strikethrough", offset: 14, length: 1 },
        { type: "spoiler", offset: 16, length: 2 },
        { type: "text_link", offset: 19, length: 1, url: "https://e.com/a)b" },
        { type: "code", offset: 21, length: 3 },
      ],
    });
  });

  it("parses pre blocks and blockquotes", () => {
    expect(
      parseMarkdownV2("```py\nprint(1)\n```\n>quoted\n>more\nafter"),
    ).toEqual({
      text: "print(1)\n\nquoted\nmore\nafter",
      entities: [
        { type: "pre", offset: 0, length: 9, language: "py" },
        { type: "blockquote", offset: 10, length: 11 },
      ],
    });
  });

  it("rejects unescaped reserved characters and unclosed entities", () => {
    expect(() => parseMarkdownV2("v1.5")).toThrow(
      "Character '.' is reserved and must be escaped with the preceding '\\'",
    );
    expect(() => parseMarkdownV2("*open")).toThrow(
      "Can't find end of Bold entity at byte offset 0",
    );
  });
});

describe("Markdown (legacy)", () => {
  it("parses bold, italic, code, pre and links", () => {
    expect(parseMarkdown("*b* _i_ `c` [l](https://e.com) a\\_b")).toEqual({
      text: "b i c l a_b",
      entities: [
        { type: "bold", offset: 0, length: 1 },
        { type: "italic", offset: 2, length: 1 },
        { type: "code", offset: 4, length: 1 },
        { type: "text_link", offset: 6, length: 1, url: "https://e.com" },
      ],
    });
    expect(() => parseMarkdown("*open")).toThrow(
      "Can't find end of the entity starting at byte offset 0",
    );
  });
});

describe("bot sends", () => {
  it("applies parse_mode to text and captions, and keeps detected links", async () => {
    const { api } = await setup();
    const sent = await api("sendMessage", {
      chat_id: GROUP,
      text: "<b>Hi</b> see https://e.com",
      parse_mode: "HTML",
    });
    expect(sent.result).toMatchObject({
      text: "Hi see https://e.com",
      entities: [
        { type: "bold", offset: 0, length: 2 },
        { type: "url", offset: 7, length: 13 },
      ],
    });

    const edited = await api("editMessageText", {
      chat_id: GROUP,
      message_id: sent.result.message_id,
      text: "*now* bold",
      parse_mode: "MarkdownV2",
    });
    expect(edited.result).toMatchObject({
      text: "now bold",
      entities: [{ type: "bold", offset: 0, length: 3 }],
    });

    const explicit = await api("sendMessage", {
      chat_id: GROUP,
      text: "<b>raw</b>",
      parse_mode: "HTML",
      entities: [{ type: "italic", offset: 0, length: 3 }],
    });
    expect(explicit.result).toMatchObject({
      text: "<b>raw</b>",
      entities: [{ type: "italic", offset: 0, length: 3 }],
    });

    expect(
      await api("sendMessage", {
        chat_id: GROUP,
        text: "1.5",
        parse_mode: "MarkdownV2",
      }),
    ).toMatchObject({
      status: 400,
      description:
        "Bad Request: can't parse entities: Character '.' is reserved and must be escaped with the preceding '\\'",
    });
    expect(
      await api("sendMessage", {
        chat_id: GROUP,
        text: "<b></b>",
        parse_mode: "HTML",
      }),
    ).toMatchObject({
      status: 400,
      description: "Bad Request: message text is empty",
    });
  });

  it("answers reply_parameters and reply_to_message_id with reply_to_message", async () => {
    const { server, api } = await setup();
    const userId = await server.createUser();
    await server.join(GROUP, userId);
    const question = await server.post(GROUP, userId, "question");

    const reply = await api("sendMessage", {
      chat_id: GROUP,
      text: "answer",
      reply_parameters: { message_id: question },
    });
    expect(reply.result.reply_to_message).toMatchObject({
      message_id: question,
      text: "question",
    });
    const legacy = await api("sendMessage", {
      chat_id: GROUP,
      text: "again",
      reply_to_message_id: question,
    });
    expect(legacy.result.reply_to_message.message_id).toBe(question);

    expect(
      await api("sendMessage", {
        chat_id: GROUP,
        text: "x",
        reply_parameters: { message_id: 999999 },
      }),
    ).toMatchObject({
      status: 400,
      description: "Bad Request: message to be replied not found",
    });
    const without = await api("sendMessage", {
      chat_id: GROUP,
      text: "x",
      reply_parameters: {
        message_id: 999999,
        allow_sending_without_reply: true,
      },
    });
    expect(without.ok).toBe(true);
    expect(without.result.reply_to_message).toBeUndefined();

    const stored = await server.getMessage(GROUP, reply.result.message_id);
    expect(stored.message.reply_to_message.message_id).toBe(question);
  });

  it("replies to a forum topic's creation message by default", async () => {
    const { server, api } = await setup();
    const forum = await server.createChat({ ownerId: OWNER, isForum: true });
    await server.setBotMembership(forum, 123456);
    const thread = await server.createTopic(forum, "Ideas");
    const sent = await api("sendMessage", {
      chat_id: forum,
      text: "in topic",
      message_thread_id: thread,
    });
    expect(sent.result).toMatchObject({
      message_thread_id: thread,
      is_topic_message: true,
      reply_to_message: {
        message_id: thread,
        forum_topic_created: { name: "Ideas" },
      },
    });
  });

  it("keeps an uploaded document's file name and type", async () => {
    const { server, api } = await setup();
    const form = new FormData();
    form.append("chat_id", String(GROUP));
    form.append("caption", "_report_");
    form.append("parse_mode", "Markdown");
    form.append(
      "document",
      new Blob(["a,b\n1,2"], { type: "text/csv; charset=utf-8" }),
      "report.csv",
    );
    const response = await fetch(`${server.origin}/bot${TOKEN}/sendDocument`, {
      method: "POST",
      body: form,
    });
    const { result } = await response.json();
    expect(result).toMatchObject({
      document: {
        file_name: "report.csv",
        mime_type: "text/csv",
        file_size: 7,
      },
      caption: "report",
      caption_entities: [{ type: "italic", offset: 0, length: 6 }],
    });

    const resent = await api("sendDocument", {
      chat_id: GROUP,
      document: result.document.file_id,
    });
    expect(resent.result.document).toMatchObject({
      file_name: "report.csv",
      mime_type: "text/csv",
    });

    const untyped = new FormData();
    untyped.append("chat_id", String(GROUP));
    untyped.append("document", new Blob(["%PDF"]), "a.pdf");
    const pdf = await (
      await fetch(`${server.origin}/bot${TOKEN}/sendDocument`, {
        method: "POST",
        body: untyped,
      })
    ).json();
    expect(pdf.result.document).toMatchObject({
      file_name: "a.pdf",
      mime_type: "application/pdf",
    });
  });

  it("takes media in a user's direct message to the bot", async () => {
    const { server, api } = await setup();
    const userId = await server.createUser();
    const messageId = await server.sendDirectMessage(userId, {
      caption: "listen",
      media: {
        type: "voice",
        bytes: Buffer.from("OggS"),
        mimeType: "audio/ogg",
      },
    });
    const photoId = await server.sendDirectMessage(userId, {
      photo: Buffer.from("png"),
    });
    const { result } = await api("getUpdates", { timeout: 0 });
    const [voice, photo] = result.map((update) => update.message);
    expect(voice).toMatchObject({
      message_id: messageId,
      chat: { id: userId, type: "private" },
      voice: { mime_type: "audio/ogg", file_size: 4 },
      caption: "listen",
    });
    expect(photo.message_id).toBe(photoId);
    expect(photo.photo.length).toBeGreaterThan(0);
    const file = await api("getFile", { file_id: voice.voice.file_id });
    const download = await fetch(
      `${server.origin}/file/bot${TOKEN}/${file.result.file_path}`,
    );
    expect(await download.text()).toBe("OggS");
    expect(await server.sendDirectMessage(userId, "plain")).toBeGreaterThan(
      photoId,
    );
  });
});
