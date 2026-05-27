const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.send("API funcionando!");
});

app.post("/webhook", async (req, res) => {
  try {
    console.log("Dados recebidos:");
    console.log(req.body);

    res.json({
      success: true,
      received: req.body
    });

  } catch (error) {
    console.error(error);

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
