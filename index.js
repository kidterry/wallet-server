const express = require("express");
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
const cors = require("cors");
const admin = require("firebase-admin");
const { Paynow } = require("paynow");
require("dotenv").config();
console.log("=== ENV CHECK START ===");
console.log("PAYNOW_ID:", process.env.PAYNOW_ID);
console.log("PAYNOW_KEY EXISTS:", !!process.env.PAYNOW_KEY);
console.log("BASE_URL:", process.env.BASE_URL);
console.log("FIREBASE EXISTS:", !!process.env.FIREBASE_SERVICE_ACCOUNT);
console.log("=== ENV CHECK END ===");

const app = express();
app.use(cors());
app.use(express.json());

// ============================
// FIREBASE INIT (FIXED)
// ============================

// IMPORTANT: DO NOT use file in production
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

// FIXED URLs (must be Railway URL, NOT Render)
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

    console.log("UID:", uid);
    console.log("AMOUNT:", amount);

    // 🔥 THIS IS "BEFORE PAYNOW SEND"
    console.log("CREATING PAYNOW PAYMENT...");

   const payment = paynow.createPayment(
  `Wallet Topup ${uid}`,
  "terrymurindi81@gmail.com"
);

    payment.add("Wallet Topup", Number(amount));

    // 🔥 PAYNOW CALL HAPPENS HERE (THIS IS THE CRITICAL POINT)
    console.log("PAYNOW_ID:", process.env.PAYNOW_ID);
console.log("PAYNOW_KEY:", process.env.PAYNOW_KEY);
console.log("TYPE OF AMOUNT:", typeof amount);
console.log("AMOUNT VALUE:", amount);
    const response = await paynow.send(payment);

    console.log("PAYNOW RESPONSE:", response);

    if (!response.success) {
      return res.status(400).json({ error: "Payment failed" });
    }

    const reference = response.reference || response.pollUrl;

    await db.collection("transactions").add({
      uid,
      amount: Number(amount),
      status: "pending",
      reference,
      pollUrl: response.pollUrl,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.json({
      redirectUrl: response.redirectUrl,
      reference,
    });

  } catch (e) {
    console.error("🔥 CREATE PAYMENT ERROR FULL:", e);
    console.error("STACK:", e.stack);
    return res.status(500).json({ error: e.message });
  }
});

// ============================
// WEBHOOK (PAYMENT CONFIRMATION)
// ============================

app.post("/paynow-webhook", async (req, res) => {
  try {
    console.log("🔥 WEBHOOK RECEIVED RAW BODY:", req.body);

    // Paynow sometimes sends data in different formats
    const reference = req.body.reference || req.body["reference"];
    const status = req.body.status || req.body["status"];

    console.log("REFERENCE:", reference);
    console.log("STATUS:", status);

    if (!reference || !status) {
      console.log("❌ Missing data from Paynow");
      return res.sendStatus(400);
    }

    const txSnap = await db
      .collection("transactions")
      .where("reference", "==", reference)
      .get();

    if (txSnap.empty) {
      console.log("❌ Transaction not found");
      return res.sendStatus(404);
    }

    const txDoc = txSnap.docs[0];
    const tx = txDoc.data();

    if (status === "Paid") {
      await db.collection("users").doc(tx.uid).update({
        wallet: admin.firestore.FieldValue.increment(tx.amount),
      });

      await txDoc.ref.update({
        status: "completed",
      });

      console.log("✅ WALLET UPDATED");
    }

    if (status === "Cancelled" || status === "Failed") {
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
// HEALTH CHECK
// ============================

app.get("/", (req, res) => {
  res.send("Wallet server running ✅");
});

// ============================
// START SERVER (FIXED FOR RAILWAY)
// ============================

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
