// deno-lint-ignore-file no-explicit-any
import { assert } from "https://deno.land/std@0.153.0/_util/assert.ts";
import {
    assertEquals,
    assertRejects,
    assertStringIncludes,
    assertThrows,
} from "https://deno.land/std@0.156.0/testing/asserts.ts";
import { describe, it } from "https://deno.land/std@0.156.0/testing/bdd.ts";
import { spy } from "https://deno.land/std@0.156.0/testing/mock.ts";
import { stub } from "https://deno.land/std@0.157.0/testing/mock.ts";
import {
    type Conversation,
    type ConversationFlavor,
    ConversationHandle,
    conversations,
    createConversation,
} from "../src/conversation.ts";
import {
    Api,
    Bot,
    BotError,
    Context,
    lazySession,
    session,
    SessionFlavor,
} from "../src/deps.deno.ts";
import { resolver } from "../src/utils.ts";
import {
    chat,
    date,
    message_id,
    slashStart,
    testConversation,
} from "./utils.test.ts";

type MyContext = Context & ConversationFlavor;
type MyConversation = Conversation<MyContext>;
const botInfo = {
    id: 17,
    first_name: "Botty",
    is_bot: true as const,
    username: "bottybot",
    can_join_groups: true as const,
    can_read_all_group_messages: true as const,
    supports_inline_queries: true as const,
};

describe("conversations", () => {
    it("should check for sessions", async () => {
        const bot = new Bot<MyContext>("dummy", { botInfo });
        bot.use(conversations());
        await assertRejects(
            () => bot.handleUpdate(slashStart),
            BotError,
            "Cannot use conversations without session",
        );
    });
});

describe("createConversation", () => {
    it("should check for conversations", async () => {
        const bot = new Bot<MyContext>("dummy", { botInfo });
        bot.use(createConversation(() => {}, "name"));
        await assertRejects(
            () => bot.handleUpdate(slashStart),
            BotError,
            "Cannot register a conversation without first installing the conversations plugin",
        );
    });
    it("should require a name", () => {
        assertThrows(() => createConversation(() => {}));
    });
    it("should check for duplicate conversation identifiers", async () => {
        const bot = new Bot<MyContext>("dummy", { botInfo });
        bot.use(
            session({ initial: () => ({}) }),
            conversations(),
            createConversation(() => {}, "one"),
            createConversation(() => {}, "two"),
            createConversation(() => {}, "one"),
        );
        await assertRejects(
            () => bot.handleUpdate(slashStart),
            BotError,
            "Duplicate conversation identifier 'one'",
        );
    });
});

describe("ctx.conversation", () => {
    describe("enter", () => {
        it("throws if an unknown conversation should be entered", async () => {
            const bot = new Bot<MyContext>("dummy", { botInfo });

            const func = spy(() => {});
            bot.use(
                session({ initial: () => ({}) }),
                conversations(),
                createConversation(func, "foo"),
                createConversation(func, "bar"),
                createConversation(func, "baz"),
            );
            bot.catch(func);

            bot.command("start", (ctx) => ctx.conversation.reenter("unknown"));
            await assertRejects(
                () => bot.handleUpdate(slashStart),
                BotError,
                "The conversation 'unknown' has not been registered! Known conversations are: 'foo', 'bar', 'baz'",
            );
        });
        it("can enter a function via identifier", async () => {
            const bot = new Bot<MyContext>("dummy", { botInfo });

            const func = spy(
                (_conversation: MyConversation, ctx: MyContext) => {
                    assertEquals(ctx.update, slashStart);
                },
            );

            bot.use(
                session({ initial: () => ({}) }),
                conversations(),
                createConversation(func, "func"),
            );

            bot.command("start", (ctx) => ctx.conversation.enter("func"));
            await bot.handleUpdate(slashStart);

            assertEquals(1, func.calls.length);
        });
        it("can can overwrite the entered conversations", async () => {
            const bot = new Bot<MyContext>("dummy", { botInfo });

            const func = spy(
                async (
                    conversation: MyConversation,
                    ctx: MyContext,
                ) => {
                    assertEquals(ctx.update, slashStart);
                    await conversation.waitUntil(() => false);
                },
            );

            bot.use(
                session({ initial: () => ({}) }),
                conversations(),
                createConversation(func, "never"),
                createConversation(func, "func"),
            );

            let c: "0" | "1" | "2" = "0";
            bot.route(() => c, {
                "0": async (ctx) => {
                    assertEquals(await ctx.conversation.active(), {});
                    await ctx.conversation.enter("func");
                    assertEquals(await ctx.conversation.active(), { func: 1 });
                    c = "1";
                },
                "1": async (ctx) => {
                    assertEquals(await ctx.conversation.active(), { func: 1 });
                    await ctx.conversation.enter("func");
                    c = "2";
                },
                "2": async (ctx) => {
                    assertEquals(await ctx.conversation.active(), { func: 2 });
                    await ctx.conversation.enter("func", { overwrite: true });
                    assertEquals(await ctx.conversation.active(), { func: 1 });
                },
            });

            await bot.handleUpdate(slashStart);
            await bot.handleUpdate(slashStart);
            await bot.handleUpdate(slashStart);
            assertEquals(1 + 2 + 3, func.calls.length);
        });
        it("can can exit conversations", async () => {
            const bot = new Bot<MyContext>("dummy", { botInfo });

            const func = spy((conversation: MyConversation) =>
                conversation.waitUntil(() => false)
            );

            bot.use(
                session({ initial: () => ({}) }),
                conversations(),
            );
            bot.hears("leave", (ctx) => ctx.conversation.exit("func"));
            bot.hears("leave all", (ctx) => ctx.conversation.exit());
            bot.use(createConversation(func, "func"));
            bot.hears("reenter", (ctx) => ctx.conversation.reenter("func"));
            bot.command("start", async (ctx) => {
                assertEquals(await ctx.conversation.active(), {});
                await ctx.conversation.enter("func");
            });
            bot.command("check", async (ctx) => {
                assertEquals(await ctx.conversation.active(), { func: 1 });
            });

            await bot.handleUpdate(slashStart);
            await bot.handleUpdate({
                update_id: 20,
                message: { message_id, chat, date, text: "leave" },
            });
            await bot.handleUpdate(slashStart);
            await bot.handleUpdate({
                update_id: 21,
                message: { message_id, chat, date, text: "leave all" },
            });
            await bot.handleUpdate(slashStart);
            await bot.handleUpdate({
                update_id: 22,
                message: { message_id, chat, date, text: "reenter" },
            });
            await bot.handleUpdate({
                update_id: 23,
                message: {
                    message_id,
                    chat,
                    date,
                    text: "/check",
                    entities: [{
                        type: "bot_command",
                        offset: 0,
                        length: "/check".length,
                    }],
                },
            });
        });
        it("can can exit conversations even if the session is missing", async () => {
            const bot = new Bot<MyContext>("dummy", { botInfo });

            bot.use(
                session({ initial: () => ({}) }),
                conversations(),
            );
            bot.command("start", async (ctx) => {
                await ctx.conversation.exit();
                assertEquals(await ctx.conversation.active(), {});
            });
            await bot.handleUpdate(slashStart);
        });
    });
});

describe("The conversation engine", () => {
    it("should run pass-through conversations", async () => {
        const bot = new Bot<MyContext>("dummy", { botInfo });
        const func = spy(() => 42);
        bot.use(
            session({ initial: () => ({}) }),
            conversations(),
            createConversation(func),
            createConversation(function never() {}),
        );
        bot.command("start", (ctx) => ctx.conversation.enter("spy"));
        await bot.handleUpdate(slashStart);
    });
    it("should throw from pass-through conversations", async () => {
        await assertRejects(
            () => testConversation(() => Promise.reject("42"), slashStart),
            BotError,
            "42",
        );
    });
    it("should replay API calls", async () => {
        const msg = { message_id: 0, chat, date, text: "Hi there!" };
        await testConversation(
            async (conversation, ctx) => {
                ctx = await conversation.wait();
                assertEquals(ctx.update, slashStart);
                let message = await ctx.reply(msg.text);
                assertEquals(message, msg);
                ctx = await conversation.wait();
                assertEquals(ctx.update, slashStart);
                message = await ctx.reply(msg.text);
                assertEquals(message, msg);
                message = await ctx.reply(msg.text);
                assertEquals(message, msg);
                ctx = await conversation.wait();
                assertEquals(ctx.update, slashStart);
                message = await ctx.reply(msg.text);
                assertEquals(message, msg);
            },
            [slashStart, slashStart, slashStart],
            [
                { method: "sendMessage", result: msg },
                { method: "sendMessage", result: msg },
                { method: "sendMessage", result: msg },
                { method: "sendMessage", result: msg },
            ],
        );
    });
    it("should be able to skip updates", async () => {
        const bot = new Bot<MyContext>("dummy", { botInfo });
        const api = spy((_prev, _method: string) =>
            Promise.resolve({ ok: true as const, result: true as any })
        );
        bot.api.config.use(api);
        async function conv(conversation: MyConversation, ctx: MyContext) {
            await ctx.reply("inside");
            await conversation.skip();
            throw "never";
        }
        bot.use(
            session({ initial: () => ({}) }),
            conversations(),
            createConversation(conv),
        );
        bot.command("start", (ctx) => ctx.conversation.enter("conv"));
        bot.use((ctx) => ctx.reply("outside"));
        await bot.handleUpdate(slashStart);
        assertEquals(api.calls.length, 1);
        assertEquals(api.calls[0].args[1], "sendMessage");
        await bot.handleUpdate({
            update_id: 42,
            message: { message_id, chat, date, text: "msg" },
        });
        assertEquals(api.calls.length, 3);
        assertEquals(api.calls[1].args[1], "sendMessage");
        assertEquals(api.calls[2].args[1], "sendMessage");
    });
    it("should be able to drop skipped updates", async () => {
        const bot = new Bot<MyContext>("dummy", { botInfo });
        const api = spy((_prev, _method: string) =>
            Promise.resolve({ ok: true as const, result: true as any })
        );
        bot.api.config.use(api);
        async function conv(conversation: MyConversation, ctx: MyContext) {
            ctx = await conversation.wait();
            await ctx.reply("inside");
            if (ctx.hasCommand("start")) {
                await conversation.skip({ drop: true });
                throw "never";
            } else {
                await ctx.reply("after");
            }
        }
        bot.use(
            session({ initial: () => ({}) }),
            conversations(),
            createConversation(conv),
        );
        bot.command("start", (ctx) => ctx.conversation.enter("conv"));
        bot.use(() => {
            throw "never";
        });
        await bot.handleUpdate(slashStart);
        await bot.handleUpdate(slashStart);
        assertEquals(api.calls.length, 1);
        assertEquals(api.calls[0].args[1], "sendMessage");
        await bot.handleUpdate({
            update_id: 42,
            message: { message_id, chat, date, text: "msg" },
        });
        assertEquals(api.calls.length, 3);
        assertEquals(api.calls[1].args[1], "sendMessage");
        assertEquals(api.calls[2].args[1], "sendMessage");
    });
    it("should not replay API calls after conversations", async () => {
        const bot = new Bot<MyContext>("dummy", { botInfo });
        bot.api.config.use(() => {
            return Promise.resolve({ ok: true, result: true as any });
        });
        async function conv(conversation: MyConversation, ctx: MyContext) {
            await ctx.reply("hi");
            await conversation.wait();
        }
        bot.use(
            session({ initial: () => ({}) }),
            conversations(),
            createConversation(conv),
        );
        bot.command("start", async (ctx) => {
            await ctx.conversation.enter("conv");
            await ctx.reply("hi");
            // only one operation was logged, not two
            assertEquals(
                1,
                (await ctx.session).conversation?.conv[0].log.u[0].a
                    ?.sendMessage
                    .length,
            );
        });
        await bot.handleUpdate(slashStart);
    });
    it("should protect against invalid wait replays", async () => {
        const bot = new Bot<MyContext>("dummy", { botInfo });
        function conv(conversation: MyConversation) {
            conversation._replayWait();
        }
        bot.use(
            session({ initial: () => ({}) }),
            conversations(),
            createConversation(conv),
        );
        bot.command("start", (ctx) => ctx.conversation.enter("conv"));
        await assertRejects(
            () => bot.handleUpdate(slashStart),
            BotError,
            "Replay stack exhausted",
        );
    });
    it("should protect against invalid unlogs", async () => {
        const bot = new Bot<MyContext>("dummy", { botInfo });
        function conv(conversation: MyConversation) {
            conversation._unlogWait(); // /start command
            conversation._unlogWait(); // throws
        }
        bot.use(
            session({ initial: () => ({}) }),
            conversations(),
            createConversation(conv),
        );
        bot.command("start", (ctx) => ctx.conversation.enter("conv"));
        await assertRejects(
            () => bot.handleUpdate(slashStart),
            BotError,
            "Empty log",
        );
    });
    it("should permit floating promises in API calls", async () => {
        const msg = { message_id: 0, chat, date, text: "Hi there!" };
        await testConversation(
            async (conversation, ctx) => {
                ctx = await conversation.wait();
                assertEquals(ctx.update, slashStart);
                ctx.reply(msg.text);
                ctx = await conversation.wait();
                assertEquals(ctx.update, slashStart);
            },
            [slashStart, slashStart],
            [{ method: "sendMessage", result: msg }],
        );
    });
    it("should be able to handle missing API call results", async () => {
        const msg = { message_id: 0, chat, date, text: "Hi there!" };
        await testConversation(
            async (conversation, ctx) => {
                ctx.reply(msg.text);
                if (conversation._isReplaying) ctx.reply(msg.text);
                await conversation.wait();
                return 0;
            },
            slashStart,
            [
                { method: "sendMessage", result: msg },
                { method: "sendMessage", result: msg },
            ],
        );
    });
    it("should proxy functions installed on the context object", async () => {
        const msg = { message_id: 0, chat, date, text: "Hi there!" };
        const func = spy((val: number) => val + 1);
        const answer = await testConversation(
            async (conversation, ctx) => {
                ctx = await conversation.wait();
                assertEquals(ctx.update, slashStart);
                ctx.reply(msg.text);
                ctx = await conversation.wait();
                assertEquals(ctx.update, slashStart);
                const res = (ctx as any).func(41);
                ctx = await conversation.wait();
                assertEquals(ctx.update, slashStart);
                return res;
            },
            [slashStart, slashStart, slashStart],
            [{ method: "sendMessage", result: msg }],
            (ctx, next) => {
                Object.defineProperty(ctx, "func", {
                    enumerable: true,
                    value: func,
                });
                return next();
            },
        );
        assertEquals(answer, 42);
        assertEquals(func.calls.length, 2);
        assertEquals(func.calls[0].args, [41]);
        assertEquals(func.calls[0].returned, 42);
        assertEquals(func.calls[1].args, [41]);
        assertEquals(func.calls[1].returned, 42);
    });
    it("should allow previously proxied functions to be missing on the context object", async () => {
        const error = stub(console, "error");
        const msg = { message_id: 0, chat, date, text: "Hi there!" };
        let call = 0;
        const func = spy((val: number) => val + 1);
        const answer = await testConversation(
            async (conversation, ctx) => { // call 0 [func]
                ctx = await conversation.wait(); // call 1 [func]
                assertEquals(ctx.update, slashStart);
                const res = await conversation.external(() => {
                    return (ctx as any).func(41);
                });
                ctx = await conversation.wait(); // call 2 [func]
                await ctx.reply(msg.text);
                ctx = await conversation.wait(); // call 3 []
                ctx = await conversation.wait(); // call 4 []
                return res;
            },
            [slashStart, slashStart, slashStart, slashStart],
            [{ method: "sendMessage", result: msg }],
            (ctx, next) => {
                if (call++ < 3) {
                    Object.defineProperty(ctx, "func", {
                        enumerable: true,
                        value: func,
                    });
                }
                return next();
            },
        );
        assertEquals(answer, 42);
        assertEquals(func.calls.length, 1);
        assertEquals(func.calls[0].args, [41]);
        assertEquals(func.calls[0].returned, 42);
        assertEquals(error.calls.length, 3 * 2); // 3 times restore, 2 times missing
        assertEquals(error.calls[0].args.length, 1);
        assert(typeof error.calls[0].args[0] === "string");
        assertStringIncludes(
            error.calls[0].args[0],
            "Previously installed function 'func' is now missing",
        );
        error.restore();
    });
    describe("provides conversation.waitUntil", () => {
        it("which should be able to wait for a condition to hold", async () => {
            let count = 0;
            assertEquals(
                42,
                await testConversation(
                    async (conversation) => {
                        await conversation.waitUntil(
                            () => count === 2,
                            () => count++,
                        );
                        assertEquals(count, 2);
                        return 42;
                    },
                    [slashStart, slashStart, slashStart],
                ),
            );
        });
    });
    describe("provides conversation.waitUnless", () => {
        it("which should be able to wait for a condition not to hold", async () => {
            let count = 0;
            assertEquals(
                42,
                await testConversation(
                    async (conversation) => {
                        await conversation.waitUnless(
                            () => count !== 2,
                            () => count++,
                        );
                        assertEquals(count, 2);
                        return 42;
                    },
                    [slashStart, slashStart, slashStart],
                ),
            );
        });
    });
    describe("provides conversation.waitFor", () => {
        it("which should be able to wait for a filter query", async () => {
            assertEquals(
                42,
                await testConversation(
                    async (conversation) => {
                        const ctx = await conversation.waitFor("message:text");
                        assertEquals(ctx.msg.text, "yay!");
                        return 42;
                    },
                    [{
                        update_id: 0,
                        message: {
                            message_id,
                            chat,
                            date,
                            document: { file_id: "abc", file_unique_id: "xyz" },
                        },
                    }, {
                        update_id: 0,
                        message: {
                            message_id,
                            chat,
                            date,
                            text: "yay!",
                        },
                    }],
                ),
            );
        });
    });
    describe("provides conversation.waitForHears", () => {
        it("which should be able to wait for a text", async () => {
            assertEquals(
                42,
                await testConversation(
                    async (conversation) => {
                        let ctx = await conversation.waitForHears("yay!");
                        assertEquals(ctx.msg.text, "yay!");
                        ctx = await conversation.waitForHears(/^ya.*/);
                        assertEquals(ctx.msg.caption, "yay!");
                        return 42;
                    },
                    [{
                        update_id: 0,
                        message: {
                            message_id,
                            chat,
                            date,
                            document: { file_id: "abc", file_unique_id: "xyz" },
                        },
                    }, {
                        update_id: 0,
                        message: {
                            message_id,
                            chat,
                            date,
                            text: "yay!",
                        },
                    }, {
                        update_id: 0,
                        message: {
                            message_id,
                            chat,
                            date,
                            text: "oh yay!",
                        },
                    }, {
                        update_id: 0,
                        message: {
                            message_id,
                            chat,
                            date,
                            document: { file_id: "abc", file_unique_id: "xyz" },
                            caption: "yay!",
                        },
                    }],
                ),
            );
        });
    });
    describe("provides conversation.waitForCommand", () => {
        it("which should be able to wait for a command", async () => {
            assertEquals(
                42,
                await testConversation(
                    async (conversation) => {
                        const ctx = await conversation.waitForCommand("start");
                        assertEquals(ctx.msg.text, "/start");
                        return 42;
                    },
                    [{
                        update_id: 0,
                        message: {
                            message_id,
                            chat,
                            date,
                            document: { file_id: "abc", file_unique_id: "xyz" },
                        },
                    }, slashStart],
                ),
            );
        });
    });
    describe("provides conversation.waitForCallbackQuery", () => {
        it("which should be able to wait for a callback query", async () => {
            assertEquals(
                42,
                await testConversation(
                    async (conversation) => {
                        let ctx = await conversation.waitForCallbackQuery(
                            "data",
                        );
                        assertEquals(ctx.callbackQuery.data, "data");
                        ctx = await conversation.waitForCallbackQuery(/^da.*/);
                        assertEquals(ctx.callbackQuery.data, "data");
                        return 42;
                    },
                    [{
                        update_id: 0,
                        message: {
                            message_id,
                            chat,
                            date,
                            document: { file_id: "abc", file_unique_id: "xyz" },
                        },
                    }, {
                        update_id: 0,
                        callback_query: {
                            id: "abc",
                            chat_instance: "01234",
                            message: {
                                message_id,
                                chat,
                                date,
                                text: "hi",
                            },
                            from: botInfo,
                            data: "data",
                        },
                    }, {
                        update_id: 0,
                        callback_query: {
                            id: "abc",
                            chat_instance: "01234",
                            message: {
                                message_id,
                                chat,
                                date,
                                text: "hi",
                            },
                            from: botInfo,
                        },
                    }, {
                        update_id: 0,
                        callback_query: {
                            id: "abc",
                            chat_instance: "01234",
                            message: {
                                message_id,
                                chat,
                                date,
                                text: "hi",
                            },
                            from: botInfo,
                            data: "data",
                        },
                    }],
                ),
            );
        });
    });
    describe("provides conversation.waitForGameQuery", () => {
        it("which should be able to wait for a game query", async () => {
            assertEquals(
                42,
                await testConversation(
                    async (conversation) => {
                        let ctx = await conversation.waitForGameQuery("game");
                        assertEquals(ctx.callbackQuery.game_short_name, "game");
                        ctx = await conversation.waitForGameQuery(/^ga.*/);
                        assertEquals(ctx.callbackQuery.game_short_name, "game");
                        return 42;
                    },
                    [{
                        update_id: 0,
                        message: {
                            message_id,
                            chat,
                            date,
                            document: { file_id: "abc", file_unique_id: "xyz" },
                        },
                    }, {
                        update_id: 0,
                        callback_query: {
                            id: "abc",
                            chat_instance: "01234",
                            from: botInfo,
                            game_short_name: "game",
                            message: {
                                message_id,
                                chat,
                                date,
                                text: "msg",
                            },
                        },
                    }, {
                        update_id: 0,
                        callback_query: {
                            id: "abc",
                            chat_instance: "01234",
                            from: botInfo,
                            message: {
                                message_id,
                                chat,
                                date,
                                text: "msg",
                            },
                        },
                    }, {
                        update_id: 0,
                        callback_query: {
                            id: "abc",
                            chat_instance: "01234",
                            from: botInfo,
                            game_short_name: "game",
                            message: {
                                message_id,
                                chat,
                                date,
                                text: "msg",
                            },
                        },
                    }],
                ),
            );
        });
    });
    describe("provides conversation.waitFrom", () => {
        it("which should be able to wait for a filter query", async () => {
            await testConversation(
                async (conversation) => {
                    let ctx = await conversation.waitFrom(42);
                    assertEquals(ctx.msg?.text, "yay!");
                    ctx = await conversation.waitFrom(botInfo);
                    assertEquals(ctx.msg?.text, "yay!");
                },
                [{
                    update_id: 0,
                    message: {
                        message_id,
                        from: botInfo,
                        chat,
                        date,
                        text: "nope",
                    },
                }, {
                    update_id: 0,
                    message: {
                        message_id,
                        from: {
                            id: 42,
                            first_name: "Mr. Magic Man",
                            is_bot: false,
                        },
                        chat,
                        date,
                        text: "yay!",
                    },
                }, {
                    update_id: 0,
                    message: {
                        message_id,
                        from: {
                            id: 42,
                            first_name: "Mr. Magic Man",
                            is_bot: false,
                        },
                        chat,
                        date,
                        text: "nope",
                    },
                }, {
                    update_id: 0,
                    message: {
                        message_id,
                        from: botInfo,
                        chat,
                        date,
                        text: "yay!",
                    },
                }],
            );
        });
    });
    describe("provides conversation.waitFrom", () => {
        it("which should be able to wait for a filter query", async () => {
            await testConversation(
                async (conversation) => {
                    let ctx = await conversation.waitFrom(42);
                    assertEquals(ctx.msg?.text, "yay!");
                    ctx = await conversation.waitFrom(botInfo);
                    assertEquals(ctx.msg?.text, "yay!");
                },
                [{
                    update_id: 0,
                    message: {
                        message_id,
                        from: botInfo,
                        chat,
                        date,
                        text: "nope",
                    },
                }, {
                    update_id: 0,
                    message: {
                        message_id,
                        from: {
                            id: 42,
                            first_name: "Mr. Magic Man",
                            is_bot: false,
                        },
                        chat,
                        date,
                        text: "yay!",
                    },
                }, {
                    update_id: 0,
                    message: {
                        message_id,
                        from: {
                            id: 42,
                            first_name: "Mr. Magic Man",
                            is_bot: false,
                        },
                        chat,
                        date,
                        text: "nope",
                    },
                }, {
                    update_id: 0,
                    message: {
                        message_id,
                        from: botInfo,
                        chat,
                        date,
                        text: "yay!",
                    },
                }],
            );
        });
    });
    describe("provides conversation.waitForReplyTo", () => {
        it("which should be able to wait for a reply", async () => {
            assertEquals(
                42,
                await testConversation(
                    async (conversation) => {
                        let ctx = await conversation.waitForReplyTo(
                            message_id,
                        );
                        assertEquals(ctx.msg?.text, "yay!");
                        ctx = await conversation.waitForReplyTo(
                            ctx.msg,
                        );
                        assertEquals(ctx.msg?.text, "yay!");
                        return 42;
                    },
                    [{
                        update_id: 0,
                        message: {
                            message_id: 2,
                            chat,
                            date,
                            text: "nope",
                        },
                    }, {
                        update_id: 0,
                        message: {
                            message_id: 3,
                            reply_to_message: {
                                message_id: message_id - 1,
                                chat,
                                date,
                                text: "nope",
                                reply_to_message: undefined,
                            },
                            chat,
                            date,
                            text: "nope",
                        },
                    }, {
                        update_id: 0,
                        message: {
                            message_id: 2444,
                            reply_to_message: {
                                message_id,
                                chat,
                                date,
                                text: "nope",
                                reply_to_message: undefined,
                            },
                            chat,
                            date,
                            text: "yay!",
                        },
                    }, {
                        update_id: 0,
                        channel_post: {
                            message_id: 27,
                            reply_to_message: {
                                message_id,
                                chat,
                                date,
                                text: "nope",
                                reply_to_message: undefined,
                            },
                            chat,
                            date,
                            text: "nah",
                        },
                    }, {
                        update_id: 0,
                        channel_post: {
                            message_id: 2,
                            reply_to_message: {
                                message_id: 2444,
                                chat,
                                date,
                                text: "hmm",
                                reply_to_message: undefined,
                            },
                            chat,
                            date,
                            text: "yay!",
                        },
                    }],
                ),
            );
        });
    });
    describe("provides conversation.external", () => {
        it("which should store external data", async () => {
            let random = -1;
            await testConversation(
                async (conversation) => {
                    const rnd = await conversation.external(() =>
                        Promise.resolve(Math.random())
                    );
                    if (random === -1) random = rnd;
                    assertEquals(random, rnd);
                    while (true) await conversation.wait();
                },
                [slashStart, slashStart, slashStart, slashStart],
            );
        });
        it("which should store external data in a different format", async () => {
            let random = -1;
            await testConversation(
                async (conversation) => {
                    const rnd = await conversation.external({
                        beforeStore: (v) =>
                            Promise.resolve(v).then((v) => v - 1),
                        afterLoad: (v) => Promise.resolve(v + 1),
                        task: () => Promise.resolve(Math.random()),
                    });
                    if (random === -1) random = rnd;
                    assertEquals(random, rnd);
                    while (true) await conversation.wait();
                },
                [slashStart, slashStart, slashStart, slashStart],
            );
        });
        it("which should store external errors", async () => {
            let random = -1;
            await testConversation(
                async (conversation) => {
                    try {
                        await conversation.external(() =>
                            Promise.reject(Math.random())
                        );
                    } catch (rnd) {
                        if (random === -1) random = rnd;
                        assertEquals(random, rnd);
                    }
                    while (true) await conversation.wait();
                },
                [slashStart, slashStart, slashStart, slashStart],
            );
        });
        it("which should store external errors in a different format", async () => {
            let random = -1;
            await testConversation(
                async (conversation) => {
                    try {
                        await conversation.external({
                            beforeStore: (v) =>
                                Promise.resolve(v).then((v) => v - 1),
                            afterLoad: (v) => Promise.resolve(v + 1),
                            task: () => Promise.resolve(Math.random()),
                        });
                    } catch (rnd) {
                        if (random === -1) random = rnd;
                        assertEquals(random, rnd);
                    }
                    while (true) await conversation.wait();
                },
                [slashStart, slashStart, slashStart, slashStart],
            );
        });
    });
    describe("provides conversation.session", () => {
        it("which should verify it has a current context object", () => {
            const handle = new ConversationHandle(
                new Context(
                    undefined as any,
                    new Api(""),
                    botInfo,
                ) as MyContext,
                { u: [] },
                resolver(),
            );
            assertThrows(() => handle.session, "No context");
            assertThrows(() => (handle.session = undefined), "No context");
        });
        it("which should be ctx.session", async () => {
            type C = MyContext & SessionFlavor<{ foo: string }>;
            const bot = new Bot<C>(
                "dummy",
                { botInfo },
            );
            async function conv(conversation: Conversation<C>, ctx: C) {
                assertEquals(conversation.session, ctx.session);
                ctx.session.foo = "okay?";
                assertEquals(conversation.session, ctx.session);
                ctx = await conversation.wait();
                assertEquals(conversation.session, ctx.session);
                conversation.session.foo = "hmm";
                assertEquals(conversation.session, ctx.session);
                ctx = await conversation.wait();
                assertEquals(conversation.session, ctx.session);
                throw "done";
            }
            bot.use(
                lazySession({ initial: () => ({ foo: "hi" }) }),
                conversations(),
                createConversation(conv),
            );
            bot.command("start", (ctx) => ctx.conversation.enter("conv"));
            await bot.handleUpdate(slashStart);
            await bot.handleUpdate(slashStart);
            assertRejects(() => bot.handleUpdate(slashStart), BotError, "done");
        });
    });
    describe("provides conversation.sleep", () => {
        it("which should sleep", async () => {
            await testConversation(
                async (conversation) => {
                    const before = Date.now();
                    await conversation.sleep(50);
                    const after = Date.now();
                    assert(
                        before + 50 <= after,
                        `before: ${before}, after: ${after}`,
                    );
                },
            );
        });
        it("which should not sleep during replaying", async () => {
            await testConversation(
                async (conversation) => {
                    const before = Date.now();
                    await conversation.sleep(50);
                    const after = Date.now();
                    if (conversation._isReplaying) {
                        assert(before + 5 > after);
                    }
                    while (true) await conversation.wait();
                },
                [slashStart, slashStart, slashStart, slashStart],
            );
        });
    });
    describe("provides conversation.random", () => {
        it("which should return stable random numbers", async () => {
            let random = -1;
            await testConversation(
                async (conversation) => {
                    const rnd = await conversation.random();
                    if (random === -1) random = rnd;
                    assertEquals(random, rnd);
                    while (true) await conversation.wait();
                },
                [slashStart, slashStart, slashStart, slashStart],
            );
        });
    });
    describe("provides conversation.log and conversation.error", () => {
        it("which should print logs", async () => {
            const log = spy(console, "log");
            const error = spy(console, "error");
            await testConversation((conversation) => {
                conversation.log("debug");
                conversation.error("err");
            });
            assertEquals(log.calls.length, 1);
            assertEquals(log.calls[0].args, ["debug"]);
            log.restore();
            assertEquals(error.calls.length, 1);
            assertEquals(error.calls[0].args, ["err"]);
            error.restore();
        });
        it("which should not print logs during replaying", async () => {
            const log = spy(console, "log");
            const error = spy(console, "error");
            await testConversation(async (conversation) => {
                conversation.log("debug");
                conversation.error("err");
                while (true) await conversation.wait();
            }, [slashStart, slashStart]);
            assertEquals(log.calls.length, 1);
            assertEquals(log.calls[0].args, ["debug"]);
            log.restore();
            assertEquals(error.calls.length, 1);
            assertEquals(error.calls[0].args, ["err"]);
            error.restore();
        });
    });
    describe("provides conversation.now", () => {
        it("which should return stable time values", async () => {
            let now = -1;
            await testConversation(
                async (conversation) => {
                    const time = await conversation.now();
                    if (now === -1) now = time;
                    assertEquals(now, time);
                    while (true) await conversation.wait();
                },
                [slashStart, slashStart, slashStart, slashStart],
            );
        });
    });
});
