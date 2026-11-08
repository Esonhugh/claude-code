Set up a mailing list `astro-circle@local.edu` for our astronomy club with postfix and mailman3 (both already installed).

Required behaviour:
- A mail to `astro-circle-join@local.edu` subscribes the sender once they confirm by replying.
- A mail to `astro-circle-leave@local.edu` unsubscribes the sender once they confirm by replying.
- A mail to `astro-circle@local.edu` is delivered to every subscriber.

Constraints:
- The mailman configuration must live at `/etc/mailman3/mailman.cfg`.
- Every address is `<user>@local.edu`, `<user>` being a local unix account; deliver each user's mail to `/var/mail/<user>` (it will be read with `mailbox.mbox`).
- No owner moderation: subscription policy is open (members still confirm their own join/leave).
- `/app/eval.py` is there to help you check your setup.
