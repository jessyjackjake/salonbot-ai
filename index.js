require("dotenv").config();
const mongoose = require("mongoose");
const express = require("express");
const axios = require("axios");
const Booking = require("./models/Booking");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

const userSessions = {};

mongoose
    .connect(process.env.MONGODB_URI)
    .then(() => console.log("MongoDB connected successfully"))
    .catch((error) => console.error("MongoDB connection error:", error.message));

function isValidDate(dateStr) {
    return /^\d{4}-\d{2}-\d{2}$/.test(dateStr);
}

function isValidTime(timeStr) {
    return /^([01]\d|2[0-3]):([0-5]\d)$/.test(timeStr);
}

function buildAppointmentDateTime(date, time) {
    return new Date(`${date}T${time}:00`);
}

function buildReminderTime(date, time) {
    const appointment = buildAppointmentDateTime(date, time);
    return new Date(appointment.getTime() - 24 * 60 * 60 * 1000);
}

async function getLatestConfirmedBookingByPhone(phone) {
    return await Booking.findOne({
        phone,
        status: "confirmed"
    }).sort({ createdAt: -1 });
}

async function isSlotTaken(date, time, excludeBookingId = null) {
    const query = {
        date,
        time,
        status: "confirmed"
    };

    if (excludeBookingId) {
        query._id = { $ne: excludeBookingId };
    }

    const existing = await Booking.findOne(query);
    return !!existing;
}

async function cancelLatestBooking(phone) {
    const latestBooking = await Booking.findOne({
        phone,
        status: "confirmed"
    }).sort({ createdAt: -1 });

    if (!latestBooking) return null;

    latestBooking.status = "cancelled";
    latestBooking.cancelledAt = new Date();
    await latestBooking.save();

    return latestBooking;
}

async function sendWhatsAppMessage(to, body) {
    return axios.post(
        `https://graph.facebook.com/v22.0/${process.env.PHONE_NUMBER_ID}/messages`,
        {
            messaging_product: "whatsapp",
            to,
            text: { body }
        },
        {
            headers: {
                Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
                "Content-Type": "application/json"
            }
        }
    );
}

// 24-hour reminder checker
setInterval(async () => {
    try {
        const now = new Date();

        const bookings = await Booking.find({
            status: "confirmed",
            reminderSent: false,
            reminderAt: { $lte: now }
        });

        for (const booking of bookings) {
            const reminderMessage =
                `Reminder ⏰\n\n` +
                `This is a 24-hour reminder for your barber appointment.\n\n` +
                `Service: ${booking.service}\n` +
                `Date: ${booking.date}\n` +
                `Time: ${booking.time}\n\n` +
                `We look forward to seeing you at BarberBot 💈`;

            try {
                await sendWhatsAppMessage(booking.phone, reminderMessage);
                booking.reminderSent = true;
                booking.reminderSentAt = new Date();
                await booking.save();

                console.log(`Reminder sent to ${booking.name}`);
            } catch (err) {
                console.error(
                    `Failed to send reminder for booking ${booking._id}:`,
                    err.response?.data || err.message
                );
            }
        }
    } catch (error) {
        console.error("Reminder system error:", error.message);
    }
}, 60000);

app.get("/", (req, res) => {
    res.send("BarberBot Webhook Server Running");
});

app.get("/bookings", async (req, res) => {
    try {
        const bookings = await Booking.find().sort({ createdAt: -1 });

        const rows = bookings
            .map(
                (booking) => `
        <tr>
          <td>${booking._id}</td>
          <td>${booking.name || "-"}</td>
          <td>${booking.phone || "-"}</td>
          <td>${booking.service || "-"}</td>
          <td>${booking.date || "-"}</td>
          <td>${booking.time || "-"}</td>
          <td>${booking.status || "-"}</td>
          <td>${booking.createdAt ? new Date(booking.createdAt).toLocaleString() : "-"}</td>
        </tr>
      `
            )
            .join("");

        const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>BarberBot Admin Dashboard</title>
        <meta charset="UTF-8" />
        <style>
          body {
            font-family: Arial, sans-serif;
            margin: 40px;
            background: #f7f7f7;
            color: #222;
          }
          h1 {
            margin-bottom: 10px;
          }
          p {
            margin-bottom: 25px;
            color: #555;
          }
          .card {
            background: #fff;
            padding: 20px;
            border-radius: 10px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.08);
            overflow-x: auto;
          }
          table {
            width: 100%;
            border-collapse: collapse;
            min-width: 900px;
          }
          th, td {
            border-bottom: 1px solid #ddd;
            padding: 12px;
            text-align: left;
          }
          th {
            background: #111;
            color: #fff;
          }
          tr:hover {
            background: #f1f1f1;
          }
        </style>
      </head>
      <body>
        <h1>BarberBot Admin Dashboard</h1>
        <p>View all customer bookings submitted through WhatsApp.</p>
        <div class="card">
          <table>
            <thead>
              <tr>
                <th>Booking ID</th>
                <th>Name</th>
                <th>Phone</th>
                <th>Service</th>
                <th>Date</th>
                <th>Time</th>
                <th>Status</th>
                <th>Created At</th>
              </tr>
            </thead>
            <tbody>
              ${rows || `<tr><td colspan="8">No bookings found.</td></tr>`}
            </tbody>
          </table>
        </div>
      </body>
      </html>
    `;

        res.send(html);
    } catch (error) {
        res.status(500).send("Failed to load dashboard");
    }
});

app.get("/webhook", (req, res) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && token === VERIFY_TOKEN) {
        console.log("Webhook verified successfully!");
        return res.status(200).send(challenge);
    }

    res.sendStatus(403);
});

const processedMessageIds = new Set();

app.post("/webhook", async (req, res) => {
    // Acknowledge Meta immediately to reduce webhook retries
    res.sendStatus(200);

    try {
        const entry = req.body.entry?.[0];
        const change = entry?.changes?.[0];
        const value = change?.value;
        const messages = value?.messages;

        // Ignore non-message events such as status updates
        if (!messages || messages.length === 0) {
            return;
        }

        const message = messages[0];
        const messageId = message.id;
        const from = message.from;
        const messageText = message.text?.body?.trim();

        // Ignore duplicates
        if (processedMessageIds.has(messageId)) {
            console.log("Duplicate message ignored:", messageId);
            return;
        }

        processedMessageIds.add(messageId);

        // Clean up old processed IDs after 10 minutes
        setTimeout(() => {
            processedMessageIds.delete(messageId);
        }, 10 * 60 * 1000);

        // Ignore non-text messages
        if (!messageText) {
            return;
        }

        const lowerText = messageText.toLowerCase();
        let replyText = "";

        let session = userSessions[from];

        // Only create a new session when the user intentionally starts
        if (!session && ["hi", "hello", "menu"].includes(lowerText)) {
            userSessions[from] = {
                step: "menu",
                booking: {},
                rescheduleBookingId: null
            };
            session = userSessions[from];
        }

        // If no session exists and the user didn't start properly
        if (!session) {
            await sendWhatsAppMessage(from, "Reply 'Hi' to see the menu again.");
            return;
        }

        const latestBooking = await getLatestConfirmedBookingByPhone(from);

        if (
            ["hi", "hello", "menu"].includes(lowerText) &&
            latestBooking
        ) {
            session.step = "menu";
            session.booking = {};
            session.rescheduleBookingId = null;

            replyText =
                `Welcome back ${latestBooking.name} 👋\n\n` +
                `Please choose an option:\n` +
                `1. Book appointment\n` +
                `2. Service prices\n` +
                `3. Opening hours\n` +
                `4. Cancel latest booking\n` +
                `5. Reschedule latest booking`;
        } else if (["hi", "hello", "menu"].includes(lowerText)) {
            session.step = "menu";
            session.booking = {};
            session.rescheduleBookingId = null;

            replyText =
                "Hello 👋 Welcome to BarberBot.\n\nPlease choose an option:\n1. Book appointment\n2. Service prices\n3. Opening hours\n4. Cancel latest booking\n5. Reschedule latest booking";
        } else if (session.step === "menu" && lowerText === "1") {
            session.step = "ask_name";
            session.booking = {};
            replyText = "Great ✂️ Please enter your full name.";
        } else if (session.step === "ask_name") {
            session.booking.name = messageText;
            session.booking.phone = from;
            session.step = "ask_service";
            replyText =
                "What barber service would you like?\n\nExamples:\n- Haircut\n- Skin fade\n- Beard trim\n- Haircut and beard\n- Line up";
        } else if (session.step === "ask_service") {
            session.booking.service = messageText;
            session.step = "ask_date";
            replyText =
                "Please enter your preferred date in this format:\nYYYY-MM-DD\n\nExample: 2026-04-10";
        } else if (session.step === "ask_date") {
            if (!isValidDate(messageText)) {
                replyText =
                    "Invalid date format ❌\nPlease enter the date as YYYY-MM-DD.\nExample: 2026-04-10";
            } else {
                session.booking.date = messageText;
                session.step = "ask_time";
                replyText =
                    "Please enter your preferred time in 24-hour format.\nExample: 14:00";
            }
        } else if (session.step === "ask_time") {
            if (!isValidTime(messageText)) {
                replyText =
                    "Invalid time format ❌\nPlease enter the time as HH:MM.\nExample: 14:00";
            } else {
                session.booking.time = messageText;

                const taken = await isSlotTaken(session.booking.date, session.booking.time);

                if (taken) {
                    replyText =
                        `Sorry ❌ ${session.booking.date} at ${session.booking.time} is already booked.\n\nPlease enter another time in HH:MM format.`;
                } else {
                    session.step = "await_confirmation";
                    replyText =
                        `Please confirm your barber appointment ✅\n\n` +
                        `Name: ${session.booking.name}\n` +
                        `Phone: ${session.booking.phone}\n` +
                        `Service: ${session.booking.service}\n` +
                        `Date: ${session.booking.date}\n` +
                        `Time: ${session.booking.time}\n\n` +
                        `Reply YES to confirm\n` +
                        `Reply NO to cancel`;
                }
            }
        } else if (session.step === "await_confirmation" && lowerText === "yes") {
            const reminderAt = buildReminderTime(
                session.booking.date,
                session.booking.time
            );

            const confirmedBooking = new Booking({
                name: session.booking.name,
                phone: session.booking.phone,
                service: session.booking.service,
                date: session.booking.date,
                time: session.booking.time,
                status: "confirmed",
                reminderAt,
                reminderSent: false
            });

            await confirmedBooking.save();

            replyText =
                `Your barber appointment is confirmed 🎉\n\n` +
                `Booking ID: ${confirmedBooking._id}\n` +
                `Name: ${confirmedBooking.name}\n` +
                `Service: ${confirmedBooking.service}\n` +
                `Date: ${confirmedBooking.date}\n` +
                `Time: ${confirmedBooking.time}\n\n` +
                `You will receive a reminder message 24 hours before your appointment.\n\n` +
                `Thank you for booking with BarberBot.`;

            session.step = "menu";
            session.booking = {};
            session.rescheduleBookingId = null;
        } else if (session.step === "await_confirmation" && lowerText === "no") {
            replyText = "Your booking has been cancelled. Reply 'Hi' to start again.";
            session.step = "menu";
            session.booking = {};
            session.rescheduleBookingId = null;
        } else if (lowerText === "2") {
            replyText =
                "Our barber services and prices include:\n- Haircut: £15\n- Skin fade: £20\n- Beard trim: £10\n- Haircut and beard: £25\n- Line up: £10";
        } else if (lowerText === "3") {
            replyText =
                "Our opening hours are:\nMon-Sat: 9:00 AM - 9:00 PM\nSunday: Closed";
        } else if (lowerText === "4" || lowerText === "cancel booking") {
            const cancelledBooking = await cancelLatestBooking(from);

            if (cancelledBooking) {
                replyText =
                    `Your latest booking has been cancelled ❌\n\n` +
                    `Service: ${cancelledBooking.service}\n` +
                    `Date: ${cancelledBooking.date}\n` +
                    `Time: ${cancelledBooking.time}`;
            } else {
                replyText = "No confirmed booking was found to cancel.";
            }

            session.step = "menu";
            session.booking = {};
            session.rescheduleBookingId = null;
        } else if (lowerText === "5" || lowerText === "reschedule booking") {
            if (!latestBooking) {
                replyText = "No confirmed booking was found to reschedule.";
            } else {
                session.step = "reschedule_date";
                session.rescheduleBookingId = latestBooking._id;
                replyText =
                    `Your latest booking is:\n\n` +
                    `Service: ${latestBooking.service}\n` +
                    `Date: ${latestBooking.date}\n` +
                    `Time: ${latestBooking.time}\n\n` +
                    `Please enter the new date in YYYY-MM-DD format.`;
            }
        } else if (session.step === "reschedule_date") {
            if (!isValidDate(messageText)) {
                replyText =
                    "Invalid date format ❌\nPlease enter the date as YYYY-MM-DD.\nExample: 2026-04-10";
            } else {
                session.booking.newDate = messageText;
                session.step = "reschedule_time";
                replyText = "Please enter the new time in HH:MM format.";
            }
        } else if (session.step === "reschedule_time") {
            if (!isValidTime(messageText)) {
                replyText =
                    "Invalid time format ❌\nPlease enter the time as HH:MM.\nExample: 14:00";
            } else {
                session.booking.newTime = messageText;

                const taken = await isSlotTaken(
                    session.booking.newDate,
                    session.booking.newTime,
                    session.rescheduleBookingId
                );

                if (taken) {
                    replyText =
                        `Sorry ❌ ${session.booking.newDate} at ${session.booking.newTime} is already booked.\n\nPlease enter another time.`;
                } else {
                    const updated = await Booking.findByIdAndUpdate(
                        session.rescheduleBookingId,
                        {
                            date: session.booking.newDate,
                            time: session.booking.newTime,
                            reminderAt: buildReminderTime(
                                session.booking.newDate,
                                session.booking.newTime
                            ),
                            reminderSent: false,
                            updatedAt: new Date()
                        },
                        { new: true }
                    );

                    if (updated) {
                        replyText =
                            `Your booking has been rescheduled successfully ✅\n\n` +
                            `Service: ${updated.service}\n` +
                            `New Date: ${updated.date}\n` +
                            `New Time: ${updated.time}\n\n` +
                            `A new 24-hour reminder will be sent before your appointment.`;
                    } else {
                        replyText = "Sorry, the booking could not be rescheduled.";
                    }

                    session.step = "menu";
                    session.booking = {};
                    session.rescheduleBookingId = null;
                }
            }
        } else {
            replyText = "I didn’t understand that. Reply 'Hi' to see the menu again.";
        }

        await sendWhatsAppMessage(from, replyText);
    } catch (error) {
        console.error("Reply error:", error.response?.data || error.message);
    }
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});