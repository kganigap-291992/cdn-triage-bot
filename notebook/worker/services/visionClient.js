// notebook/worker/services/visionClient.js

const fs = require("fs");

const OpenAI = require("openai");

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

async function analyzeDiagramImage(imagePath) {
  const base64Image = fs
    .readFileSync(imagePath)
    .toString("base64");

  const response = await client.responses.create({
    model: "gpt-4.1-mini",
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text:
              "Analyze this technical onboarding diagram or chart. " +
              "Summarize the architecture flow, important systems, " +
              "and operational meaning in concise engineering language.",
          },
          {
            type: "input_image",
            image_url: `data:image/png;base64,${base64Image}`,
          },
        ],
      },
    ],
  });

  return response.output_text || "";
}

module.exports = {
  analyzeDiagramImage,
};