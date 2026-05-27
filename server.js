const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");

const app = express();

app.use(cors());
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

app.get("/", (req, res) => {
  res.send("API funcionando!");
});

app.post("/api/yampi/webhook", async (req, res) => {
  try {

    console.log("Webhook recebido");

    const data = req.body;

    await supabase
      .from("orders")
      .insert([
        {
          order_id: data.id?.toString(),
          customer_name: data.customer?.name || "",
          customer_email: data.customer?.email || "",
          total: data.total || "",
          status: data.status || ""
        }
      ]);

    res.status(200).json({
      success: true
    });

  } catch (error) {

    console.error(error);

    res.status(500).json({
      error: error.message
    });

  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
