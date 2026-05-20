const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const { Paynow } = require("paynow");
require("dotenv").config();

const app = express();

// ============================
// MIDDLEWARE
// ============================

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ============================
// FIREBASE INIT
// ============================

const raw = process.env.FIREBASE_SERVICE_ACCOUNT;

if (!raw) {
  console.error("❌ FIREBASE_SERVICE_ACCOUNT is missing in Railway");
  process.exit(1);
}

let serviceAccount;

try {
  serviceAccount = JSON.parse(raw);
} catch (err) {
  console.error("❌ FIREBASE_SERVICE_ACCOUNT is invalid JSON");
  console.error(err.message);
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

// ============================
// PAYNOW INIT
// ============================

const paynow = new Paynow(
  process.env.PAYNOW_ID,
  process.env.PAYNOW_KEY
);

const BASE_URL = process.env.BASE_URL;

paynow.resultUrl = `${BASE_URL}/paynow-webhook`;
paynow.returnUrl = `${BASE_URL}/return`;

// ============================
// CREATE PAYMENT
// ============================

app.post("/create-payment", async (req, res) => {
  try {
    console.log("REQUEST RECEIVED:", req.body);

    const { uid, amount } = req.body;

    if (!uid || !amount) {
      return res.status(400).json({
        error: "uid and amount required",
      });
    }

    console.log("UID:", uid);
    console.log("AMOUNT:", amount);

    // YOUR INTERNAL REFERENCE
    const reference = `wallet_${uid}_${Date.now()}`;

    console.log("REFERENCE CREATED:", reference);

    // IMPORTANT:
    // USE YOUR INTERNAL REFERENCE HERE
    const payment = paynow.createPayment(
      reference,
      "terrymurindi81@gmail.com"
    );

    payment.add("Wallet Topup", Number(amount));

    console.log("CREATING PAYNOW PAYMENT...");

    const response = await paynow.send(payment);

    console.log("PAYNOW RESPONSE:", response);

    if (!response.success) {
      return res.status(400).json({
        error: "Payment failed",
      });
    }

    // THIS IS THE IMPORTANT PAYNOW ID
    const paynowReference = response.pollUrl;

    console.log("PAYNOW REFERENCE:", paynowReference);

    // SAVE TRANSACTION
    await db.collection("transactions").add({
      uid,
      amount: Number(amount),
      status: "pending",

      // YOUR INTERNAL ID
      reference,

      // PAYNOW IDENTIFIER
      paynowReference,

      pollUrl: response.pollUrl,

      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    console.log("✅ TRANSACTION SAVED");

    return res.json({
      redirectUrl: response.redirectUrl,
      reference,
    });

  } catch (e) {
    console.error("🔥 CREATE PAYMENT ERROR:", e);
    return res.status(500).json({
      error: e.message,
    });
  }
});

// ============================
// WEBHOOK
// ============================

app.post("/paynow-webhook", async (req, res) => {
  try {
    console.log("🔥 WEBHOOK RECEIVED RAW BODY:", req.body);

    const status = req.body.status;
    const pollUrl = req.body.pollurl;

    console.log("STATUS:", status);
    console.log("POLL URL:", pollUrl);

    if (!pollUrl || !status) {
      console.log("❌ Missing pollUrl or status");
      return res.sendStatus(400);
    }

    // MATCH USING pollUrl
    const txSnap = await db
      .collection("transactions")
      .where("pollUrl", "==", pollUrl)
      .get();

    if (txSnap.empty) {
      console.log("❌ Transaction not found");
      return res.sendStatus(404);
    }

    const txDoc = txSnap.docs[0];
    const tx = txDoc.data();

    console.log("✅ TRANSACTION FOUND");

    // ============================
    // PAYMENT SUCCESS
    // ============================

    if (status === "Paid") {

      // PREVENT DOUBLE CREDIT
      if (tx.status === "completed") {
        console.log("⚠️ Payment already processed");
        return res.sendStatus(200);
      }

      await db.collection("users").doc(tx.uid).update({
        wallet: admin.firestore.FieldValue.increment(tx.amount),
      });

      await txDoc.ref.update({
        status: "completed",
        paidAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      console.log("✅ WALLET UPDATED");
    }

    // ============================
    // PAYMENT FAILED
    // ============================

    if (
      status === "Cancelled" ||
      status === "Failed"
    ) {
      await txDoc.ref.update({
        status: "failed",
      });

      console.log("⚠️ PAYMENT FAILED");
    }

    return res.sendStatus(200);

  } catch (e) {
    console.error("🔥 WEBHOOK ERROR:", e);
    return res.sendStatus(500);
  }
});

// ============================
// RETURN PAGE
// ============================

app.get("/return", (req, res) => {
  res.send("Payment completed. You may close this page.");
});

// ============================
// HEALTH CHECK
// ============================

app.get("/", (req, res) => {
  res.send("Wallet server running ✅");
});

// ============================
// START SERVER
// ============================

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
