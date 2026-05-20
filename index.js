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
  console.error("❌ Invalid FIREBASE_SERVICE_ACCOUNT JSON");
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
// HEALTH CHECK
// ============================
app.get("/", (req, res) => {
  res.send("Wallet server running ✅");
});

// ============================
// RETURN PAGE
// ============================
app.get("/return", (req, res) => {
  res.send("Payment completed. You may close this page.");
});

// ============================
// CREATE PAYMENT (DEPOSIT)
// ============================
app.post("/create-payment", async (req, res) => {
  try {
    const { uid, amount } = req.body;

    console.log("REQUEST:", req.body);

    if (!uid || !amount) {
      return res.status(400).json({ error: "uid and amount required" });
    }

    if (Number(amount) <= 0) {
      return res.status(400).json({ error: "Invalid amount" });
    }

    const reference = `wallet_${uid}_${Date.now()}`;

    const payment = paynow.createPayment(reference);
    payment.add("Wallet Topup", Number(amount));

    console.log("CREATING PAYNOW PAYMENT...");

    const response = await paynow.send(payment);

    console.log("PAYNOW RESPONSE:", response);

    if (!response.success) {
      return res.status(400).json({
        error: response.error || "Payment failed",
      });
    }

    await db.collection("transactions").add({
      uid,
      amount: Number(amount),
      reference,
      pollUrl: response.pollUrl,
      status: "pending",
      processed: false,
      type: "deposit",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.json({
      success: true,
      redirectUrl: response.redirectUrl,
      reference,
    });

  } catch (e) {
    console.error("🔥 CREATE PAYMENT ERROR:", e);
    return res.status(500).json({ error: e.message });
  }
});

// ============================
// PAYNOW WEBHOOK
// ============================
app.post("/paynow-webhook", async (req, res) => {
  try {
    console.log("🔥 WEBHOOK BODY:", req.body);

    const status = req.body.status;
    const pollUrl = req.body.pollurl;

    if (!status || !pollUrl) {
      return res.sendStatus(400);
    }

    const txSnap = await db
      .collection("transactions")
      .where("pollUrl", "==", pollUrl)
      .limit(1)
      .get();

    if (txSnap.empty) {
      return res.sendStatus(404);
    }

    const txDoc = txSnap.docs[0];

    await db.runTransaction(async (t) => {
      const freshTx = await t.get(txDoc.ref);
      const tx = freshTx.data();

      if (tx.processed) return;

      if (status === "Paid") {
        const userRef = db.collection("users").doc(tx.uid);

        t.update(userRef, {
          walletBalance: admin.firestore.FieldValue.increment(tx.amount),
        });

        const ledgerRef = db.collection("ledger").doc();

        t.set(ledgerRef, {
          uid: tx.uid,
          type: "credit",
          source: "paynow",
          amount: tx.amount,
          reference: tx.reference,
          status: "completed",
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        t.update(txDoc.ref, {
          status: "completed",
          processed: true,
          paidAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        console.log("✅ WALLET CREDITED");
      }

      if (status === "Cancelled" || status === "Failed") {
        t.update(txDoc.ref, {
          status: "failed",
          processed: true,
        });

        console.log("⚠️ PAYMENT FAILED");
      }
    });

    return res.sendStatus(200);

  } catch (e) {
    console.error("🔥 WEBHOOK ERROR:", e);
    return res.sendStatus(500);
  }
});

// ============================
// UNLOCK CONTACT ($0.50 FIXED)
// ============================
app.post("/unlock-contact", async (req, res) => {
  try {
    const { uid, listingId } = req.body;

    if (!uid || !listingId) {
      return res.status(400).json({ error: "Missing fields" });
    }

    const amount = 0.50; // 🔥 FIXED PRICE

    const userRef = db.collection("users").doc(uid);

    await db.runTransaction(async (t) => {
      const userDoc = await t.get(userRef);

      if (!userDoc.exists) {
        throw new Error("User not found");
      }

      const balance = userDoc.data().walletBalance || 0;

      if (balance < amount) {
        throw new Error("Insufficient wallet balance");
      }

      const existingUnlock = await db
        .collection("unlockedListings")
        .where("uid", "==", uid)
        .where("listingId", "==", listingId)
        .limit(1)
        .get();

      if (!existingUnlock.empty) {
        throw new Error("Already unlocked");
      }

      t.update(userRef, {
        walletBalance: admin.firestore.FieldValue.increment(-amount),
      });

      const ledgerRef = db.collection("ledger").doc();

      t.set(ledgerRef, {
        uid,
        type: "debit",
        source: "unlock_contact",
        amount,
        listingId,
        status: "completed",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      const unlockRef = db.collection("unlockedListings").doc();

      t.set(unlockRef, {
        uid,
        listingId,
        amount,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    return res.json({
      success: true,
      unlockPrice: amount,
    });

  } catch (e) {
    console.error("🔥 UNLOCK ERROR:", e);
    return res.status(400).json({ error: e.message });
  }
});

// ============================
// TRANSACTIONS (LEDGER)
// ============================
app.get("/transactions/:uid", async (req, res) => {
  try {
    const { uid } = req.params;

    const snap = await db
      .collection("ledger")
      .where("uid", "==", uid)
      .orderBy("createdAt", "desc")
      .get();

    const data = snap.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
    }));

    return res.json(data);

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// ============================
// START SERVER
// ============================
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
