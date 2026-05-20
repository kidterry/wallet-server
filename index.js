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
  console.error("❌ FIREBASE_SERVICE_ACCOUNT missing");
  process.exit(1);
}

let serviceAccount;

try {
  serviceAccount = JSON.parse(raw);
} catch (err) {
  console.error("❌ Invalid FIREBASE JSON");
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
// CREATE PAYMENT (SECURE)
// ============================

app.post("/create-payment", async (req, res) => {
  try {
    const { uid, amount } = req.body;

    if (!uid || !amount) {
      return res.status(400).json({ error: "Missing uid/amount" });
    }

    const reference = `wallet_${uid}_${Date.now()}`;

    console.log("REFERENCE:", reference);

    const payment = paynow.createPayment(reference);

    payment.add("Wallet Topup", Number(amount));

    const response = await paynow.send(payment);

    if (!response.success) {
      console.log("PAYNOW ERROR:", response);
      return res.status(400).json({ error: "Payment failed" });
    }

    const paynowReference = response.pollUrl;

    await db.collection("transactions").add({
      uid,
      amount: Number(amount),
      status: "pending",
      reference,
      paynowReference,
      pollUrl: response.pollUrl,
      processed: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.json({
      redirectUrl: response.redirectUrl,
      reference,
    });

  } catch (e) {
    console.error("CREATE ERROR:", e);
    return res.status(500).json({ error: e.message });
  }
});

// ============================
// WEBHOOK (SECURE + IDENTITY SAFE)
// ============================

app.post("/paynow-webhook", async (req, res) => {
  try {
    console.log("🔥 WEBHOOK:", req.body);

    const pollUrl = req.body.pollurl;
    const status = req.body.status;

    if (!pollUrl || !status) {
      return res.sendStatus(400);
    }

    const txSnap = await db
      .collection("transactions")
      .where("pollUrl", "==", pollUrl)
      .limit(1)
      .get();

    if (txSnap.empty) {
      console.log("❌ Transaction not found");
      return res.sendStatus(404);
    }

    const txDoc = txSnap.docs[0];
    const tx = txDoc.data();

    // ============================
    // IDENTITY LOCK (ANTI DOUBLE CREDIT)
    // ============================

    if (tx.processed === true) {
      console.log("⚠️ Already processed");
      return res.sendStatus(200);
    }

    // ============================
    // SUCCESS PAYMENT
    // ============================

    if (status === "Paid") {

      await db.runTransaction(async (t) => {
        const doc = await t.get(txDoc.ref);

        if (doc.data().processed) {
          return;
        }

        t.update(txDoc.ref, {
          status: "completed",
          processed: true,
          paidAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        t.update(db.collection("users").doc(tx.uid), {
          wallet: admin.firestore.FieldValue.increment(tx.amount),
        });
      });

      console.log("✅ WALLET UPDATED");
    }

    // ============================
    // FAILED PAYMENT
    // ============================

    if (status === "Cancelled" || status === "Failed") {
      await txDoc.ref.update({
        status: "failed",
        processed: true,
      });

      console.log("⚠️ PAYMENT FAILED");
    }

    return res.sendStatus(200);

  } catch (e) {
    console.error("WEBHOOK ERROR:", e);
    return res.sendStatus(500);
  }
});

// ============================
// RETURN
// ============================

app.get("/return", (req, res) => {
  res.send("Payment completed. You may close this page.");
});

// ============================
// HEALTH
// ============================

app.get("/", (req, res) => {
  res.send("Wallet server running ✅");
});

// ============================
// START
// ============================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server running on", PORT);
});
