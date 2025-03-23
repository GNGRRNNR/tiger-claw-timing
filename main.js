// IMPORTANT: Replace this with your actual Google Apps Script Web App URL
const SCRIPT_URL = "https://script.google.com/macros/s/AKfycbxfqGtjmo26ZYjJRwyUWE2356sP-magLAvyfSa10kPg9bhn5LSnoE5loC75u73il-br/exec";

document.addEventListener("DOMContentLoaded", () => {
  const form = document.getElementById("scanForm");
  const responseDiv = document.getElementById("responseMessage");

  form.addEventListener("submit", async (event) => {
    event.preventDefault();

    const bibNumber = document.getElementById("bibNumber").value.trim();
    const runnerName = document.getElementById("runnerName").value.trim();
    const checkpoint = document.getElementById("checkpoint").value;
    const timestamp = new Date().toISOString();

    const scanData = {
      action: "recordScan",
      data: {
        bibNumber,
        runnerName,
        checkpoint,
        timestamp
      }
    };

    try {
      const res = await fetch(SCRIPT_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(scanData)
      });

      const result = await res.json();

      if (result.success) {
        responseDiv.innerHTML = `<p style="color: green;">✅ Scan recorded for ${runnerName} at ${checkpoint}</p>`;
        form.reset();
      } else {
        responseDiv.innerHTML = `<p style="color: red;">❌ ${result.error || 'Scan failed.'}</p>`;
      }
    } catch (error) {
      console.error(error);
      responseDiv.innerHTML = `<p style="color: red;">
