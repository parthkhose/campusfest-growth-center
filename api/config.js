// GET /api/config -> which connections are set on the server (never returns secrets).
export default function handler(req, res) {
  res.setHeader('cache-control', 'no-store');
  res.status(200).json({
    gemini_configured: Boolean(process.env.GEMINI_API_KEY),
    gemini_model: process.env.GEMINI_MODEL || 'gemini-3-flash-preview',
    env: {
      sampleScriptUrl: process.env.SAMPLE_SCRIPT_URL || '',
      trackerScriptUrl: process.env.TRACKER_SCRIPT_URL || '',
      sampleSheetId: process.env.SAMPLE_SHEET_ID || '',
      trackerSheetId: process.env.TRACKER_SHEET_ID || '',
    },
    write_token_on_server: Boolean(process.env.WRITE_TOKEN),
  });
}
