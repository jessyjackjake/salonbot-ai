require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const axios = require("axios");
const Booking = require("./models/Booking");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

const userSessions = {};
const processedMessageIds = new Set();

mongoose
    .connect(process.env.MONGODB_URI)
    .then(() => {
        console.log("MongoDB connected successfully");
    })
    .catch((error) => {
        console.error("MongoDB connection error:", error.message);
    });

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
    return Booking.findOne({
        phone: phone,
        status: "confirmed"
    }).sort({ createdAt: -1 });
}

async function isSlotTaken(date, time, excludeBookingId = null) {
    const query = {
        date: date,
        time: time,
        status: "confirmed"
    };

    if (excludeBookingId) {
        query._id = { $ne: excludeBookingId };
    }

    const existingBooking = await Booking.findOne(query);
    return !!existingBooking;
}

async function cancelLatestBooking(phone) {
    const latestBooking = await Booking.findOne({
        phone: phone,
        status: "confirmed"
    }).sort({ createdAt: -1 });

    if (!latestBooking) {
        return null;
    }

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
            to: to,
            text: { body: body }
        },
        {
            headers: {
                Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
                "Content-Type": "application/json"
            }
        }
    );
}

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
                `Reminder\n\n` +
                `This is a 24-hour reminder for your barber appointment.\n\n` +
                `Service: ${booking.service}\n` +
                `Date: ${booking.date}\n` +
                `Time: ${booking.time}\n\n` +
                `We look forward to seeing you at BarberBot.`;

            try {
                await sendWhatsAppMessage(booking.phone, reminderMessage);
                booking.reminderSent = true;
                booking.reminderSentAt = new Date();
                await booking.save();

                console.log(`Reminder sent to ${booking.name}`);
            } catch (error) {
                console.error(
                    `Failed to send reminder for booking ${booking._id}:`,
                    error.response?.data || error.message
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

        let rows = "";

        bookings.forEach((booking) => {
            rows += `
                <tr>
                    <td>${booking.name || ""}</td>
                    <td>${booking.phone || ""}</td>
                    <td>${booking.service || ""}</td>
                    <td>${booking.date || ""}</td>
                    <td>${booking.time || ""}</td>
                    <td>${booking.status || ""}</td>
                </tr>
            `;
        });

        const html = `
            <!DOCTYPE html>
            <html>
            <head>
                <title>Bookings</title>
                <meta charset="UTF-8">
                <style>
                    body {
                        font-family: Arial, sans-serif;
                        margin: 30px;
                    }
                    table {
                        width: 100%;
                        border-collapse: collapse;
                    }
                    th, td {
                        border: 1px solid #ccc;
                        padding: 10px;
                        text-align: left;
                    }
                    th {
                        background-color: #f2f2f2;
                    }
                </style>
            </head>
            <body>
                <h1>Bookings</h1>
                <table>
                    <thead>
                        <tr>
                            <th>Name</th>
                            <th>Phone</th>
                            <th>Service</th>
                            <th>Date</th>
                            <th>Time</th>
                            <th>Status</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${rows || '<tr><td colspan="6">No bookings found</td></tr>'}
                    </tbody>
                </table>
            </body>
            </html>
        `;

        res.send(html);
    } catch (error) {
        res.status(500).send("Could not load bookings");
    }
});

app.get("/webhook", (req, res) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && token === VERIFY_TOKEN) {
        console.log("Webhook verified successfully");
        return res.status(200).send(challenge);
    }

    res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
    res.sendStatus(200);

    try {
        const entry = req.body.entry?.[0];
        const change = entry?.changes?.[0];
        const value = change?.value;
        const messages = value?.messages;

        if (!messages || messages.length === 0) {
            return;
        }

        const message = messages[0];
        const messageId = message.id;
        const from = message.from;
        const messageText = message.text?.body?.trim();

        if (!messageText) {
            return;
        }

        const messageTimestamp = Number(message.timestamp);
        const nowInSeconds = Math.floor(Date.now() / 1000);

        if (messageTimestamp && nowInSeconds - messageTimestamp > 120) {
            console.log("Old message ignored:", {
                id: messageId,
                from: from,
                text: messageText,
                ageInSeconds: nowInSeconds - messageTimestamp
            });
            return;
        }

        if (processedMessageIds.has(messageId)) {
            console.log("Duplicate message ignored:", messageId);
            return;
        }

        processedMessageIds.add(messageId);

        setTimeout(() => {
            processedMessageIds.delete(messageId);
        }, 10 * 60 * 1000);

        const lowerText = messageText.toLowerCase();
        let replyText = "";
        let session = userSessions[from];

        if (!session && (lowerText === "hi" || lowerText === "hello" || lowerText === "menu")) {
            userSessions[from] = {
                step: "menu",
                booking: {},
                rescheduleBookingId: null
            };
            session = userSessions[from];
        }

        if (!session) {
            await sendWhatsAppMessage(from, "Reply 'Hi' to see the menu again.");
            return;
        }

        const latestBooking = await getLatestConfirmedBookingByPhone(from);

        if ((lowerText === "hi" || lowerText === "hello" || lowerText === "menu") && latestBooking) {
            session.step = "menu";
            session.booking = {};
            session.rescheduleBookingId = null;

            replyText =
                `Welcome back ${latestBooking.name}\n\n` +
                `Please choose an option:\n` +
                `1. Book appointment\n` +
                `2. Service prices\n` +
                `3. Opening hours\n` +
                `4. Cancel latest booking\n` +
                `5. Reschedule latest booking`;
        } else if (lowerText === "hi" || lowerText === "hello" || lowerText === "menu") {
            session.step = "menu";
            session.booking = {};
            session.rescheduleBookingId = null;

            replyText =
                "Hello. Welcome to BarberBot.\n\n" +
                "Please choose an option:\n" +
                "1. Book appointment\n" +
                "2. Service prices\n" +
                "3. Opening hours\n" +
                "4. Cancel latest booking\n" +
                "5. Reschedule latest booking";
        } else if (session.step === "menu" && lowerText === "1") {
            session.step = "ask_name";
            session.booking = {};
            replyText = "Please enter your full name.";
        } else if (session.step === "ask_name") {
            session.booking.name = messageText;
            session.booking.phone = from;
            session.step = "ask_service";

            replyText =
                "What barber service would you like?\n\n" +
                "Examples:\n" +
                "- Haircut\n" +
                "- Skin fade\n" +
                "- Beard trim\n" +
                "- Haircut and beard\n" +
                "- Line up";
        } else if (session.step === "ask_service") {
            session.booking.service = messageText;
            session.step = "ask_date";

            replyText =
                "Please enter your preferred date in this format:\n" +
                "YYYY-MM-DD\n\n" +
                "Example: 2026-04-10";
        } else if (session.step === "ask_date") {
            if (!isValidDate(messageText)) {
                replyText =
                    "Invalid date format.\n" +
                    "Please enter the date as YYYY-MM-DD.\n" +
                    "Example: 2026-04-10";
            } else {
                session.booking.date = messageText;
                session.step = "ask_time";

                replyText =
                    "Please enter your preferred time in 24-hour format.\n" +
                    "Example: 14:00";
            }
        } else if (session.step === "ask_time") {
            if (!isValidTime(messageText)) {
                replyText =
                    "Invalid time format.\n" +
                    "Please enter the time as HH:MM.\n" +
                    "Example: 14:00";
            } else {
                session.booking.time = messageText;

                const taken = await isSlotTaken(session.booking.date, session.booking.time);

                if (taken) {
                    replyText =
                        `Sorry, ${session.booking.date} at ${session.booking.time} is already booked.\n\n` +
                        "Please enter another time in HH:MM format.";
                } else {
                    session.step = "await_confirmation";

                    replyText =
                        "Please confirm your barber appointment.\n\n" +
                        `Name: ${session.booking.name}\n` +
                        `Phone: ${session.booking.phone}\n` +
                        `Service: ${session.booking.service}\n` +
                        `Date: ${session.booking.date}\n` +
                        `Time: ${session.booking.time}\n\n` +
                        "Reply YES to confirm\n" +
                        "Reply NO to cancel";
                }
            }
        } else if (session.step === "await_confirmation" && lowerText === "yes") {
            const reminderAt = buildReminderTime(session.booking.date, session.booking.time);

            const confirmedBooking = new Booking({
                name: session.booking.name,
                phone: session.booking.phone,
                service: session.booking.service,
                date: session.booking.date,
                time: session.booking.time,
                status: "confirmed",
                reminderAt: reminderAt,
                reminderSent: false
            });

            await confirmedBooking.save();

            replyText =
                "Your barber appointment is confirmed.\n\n" +
                `Booking ID: ${confirmedBooking._id}\n` +
                `Name: ${confirmedBooking.name}\n` +
                `Service: ${confirmedBooking.service}\n` +
                `Date: ${confirmedBooking.date}\n` +
                `Time: ${confirmedBooking.time}\n\n` +
                "You will receive a reminder message 24 hours before your appointment.\n\n" +
                "Thank you for booking with BarberBot.";

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
                "Our barber services and prices include:\n" +
                "- Haircut: £15\n" +
                "- Skin fade: £20\n" +
                "- Beard trim: £10\n" +
                "- Haircut and beard: £25\n" +
                "- Line up: £10";
        } else if (lowerText === "3") {
            replyText =
                "Our opening hours are:\n" +
                "Mon-Sat: 9:00 AM - 9:00 PM\n" +
                "Sunday: Closed";
        } else if (lowerText === "4" || lowerText === "cancel booking") {
            const cancelledBooking = await cancelLatestBooking(from);

            if (cancelledBooking) {
                replyText =
                    "Your latest booking has been cancelled.\n\n" +
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
                    "Your latest booking is:\n\n" +
                    `Service: ${latestBooking.service}\n` +
                    `Date: ${latestBooking.date}\n` +
                    `Time: ${latestBooking.time}\n\n` +
                    "Please enter the new date in YYYY-MM-DD format.";
            }
        } else if (session.step === "reschedule_date") {
            if (!isValidDate(messageText)) {
                replyText =
                    "Invalid date format.\n" +
                    "Please enter the date as YYYY-MM-DD.\n" +
                    "Example: 2026-04-10";
            } else {
                session.booking.newDate = messageText;
                session.step = "reschedule_time";
                replyText = "Please enter the new time in HH:MM format.";
            }
        } else if (session.step === "reschedule_time") {
            if (!isValidTime(messageText)) {
                replyText =
                    "Invalid time format.\n" +
                    "Please enter the time as HH:MM.\n" +
                    "Example: 14:00";
            } else {
                session.booking.newTime = messageText;

                const taken = await isSlotTaken(
                    session.booking.newDate,
                    session.booking.newTime,
                    session.rescheduleBookingId
                );

                if (taken) {
                    replyText =
                        `Sorry, ${session.booking.newDate} at ${session.booking.newTime} is already booked.\n\n` +
                        "Please enter another time.";
                } else {
                    const updatedBooking = await Booking.findByIdAndUpdate(
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

                    if (updatedBooking) {
                        replyText =
                            "Your booking has been rescheduled successfully.\n\n" +
                            `Service: ${updatedBooking.service}\n` +
                            `New Date: ${updatedBooking.date}\n` +
                            `New Time: ${updatedBooking.time}\n\n` +
                            "A new 24-hour reminder will be sent before your appointment.";
                    } else {
                        replyText = "Sorry, the booking could not be rescheduled.";
                    }

                    session.step = "menu";
                    session.booking = {};
                    session.rescheduleBookingId = null;
                }
            }
        } else {
            replyText = "I did not understand that. Reply 'Hi' to see the menu again.";
        }

        await sendWhatsAppMessage(from, replyText);
    } catch (error) {
        console.error("Reply error:", error.response?.data || error.message);
    }
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});