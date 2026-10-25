# Gate manual test

1. In the owner private chat run `/gatetest`; for five minutes the owner receives the non-member lock path without leaving the configured channel.
2. Use an account that is a member of only some gates and send `/start`, `/help`, `/music`, a callback, and an Instagram URL. Every path must show the gate lock and must not execute the request.
3. Join every configured gate and press `✅ عضو شدم`; the membership check must bypass the negative cache and run the pending request.
4. Leave one gate and repeat a request; the lock must return.
5. In `Checker`, test `/start@SearcherMusiic_Bot`, `/start`, `راهنما`, a short artist/title, a reply to the bot, and a topic message. Confirm `/diag` shows the latest update and latest drop reason.
6. Verify the owner panel shows an invalid gate warning when `getChatMember` cannot resolve a configured gate. Record the exact Bot API response and do not mark this file green without it.
