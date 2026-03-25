const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { url, userMessage, pageContext } = await req.json();

    if (!url) {
      return new Response(
        JSON.stringify({ success: false, error: 'URL is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const firecrawlKey = Deno.env.get('FIRECRAWL_API_KEY');
    if (!firecrawlKey) {
      return new Response(
        JSON.stringify({ success: false, error: 'Firecrawl connector not configured' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const lovableKey = Deno.env.get('LOVABLE_API_KEY');
    if (!lovableKey) {
      return new Response(
        JSON.stringify({ success: false, error: 'LOVABLE_API_KEY not configured' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Step 1: Scrape the current page with Firecrawl
    console.log('Scraping URL:', url);
    const scrapeResponse = await fetch('https://api.firecrawl.dev/v1/scrape', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${firecrawlKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url,
        formats: ['markdown', 'screenshot'],
        onlyMainContent: false,
        waitFor: 2000,
      }),
    });

    const scrapeData = await scrapeResponse.json();
    if (!scrapeResponse.ok) {
      console.error('Firecrawl error:', scrapeData);
      return new Response(
        JSON.stringify({ success: false, error: `Firecrawl scrape failed: ${scrapeData.error || scrapeResponse.status}` }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const markdown = scrapeData.data?.markdown || scrapeData.markdown || '';
    const screenshot = scrapeData.data?.screenshot || scrapeData.screenshot || '';
    const pageTitle = scrapeData.data?.metadata?.title || scrapeData.metadata?.title || '';

    // Step 2: Send to AI to analyze and find next action
    const systemPrompt = `You are an Integration Guide AI. You help users navigate web applications to set up integrations.

Given a webpage's content (markdown + screenshot), analyze it and determine the NEXT action the user should take.

IMPORTANT RULES:
- Do NOT click anything yourself. You are a GUIDE only.
- Identify the specific UI element (button, link, input field) the user needs to interact with.
- Return a CSS selector that uniquely identifies that element, or describe its position.
- Be concise and helpful.

Respond in this exact JSON format:
{
  "message": "A friendly explanation of what this page is and what the user should do next",
  "element": {
    "selector": "CSS selector for the element (e.g., button.submit-btn, a[href='/settings'], #connect-btn)",
    "description": "Short label for the element (e.g., 'Connect' button, 'Settings' link)",
    "action": "click | fill | select"
  },
  "nextStep": "Brief preview of what comes after this step"
}

If you cannot identify a specific element, omit the "element" field and just provide guidance in "message".`;

    const userPrompt = `Page URL: ${url}
Page Title: ${pageTitle}
User's Goal: ${userMessage}
${pageContext ? `Integration Journey So Far: ${pageContext}` : ''}

Page Content (Markdown):
${markdown.substring(0, 8000)}

${screenshot ? 'A screenshot of the page is also available for visual reference.' : ''}

Analyze this page and tell the user what to do next to achieve their goal.`;

    const aiResponse = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${lovableKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'google/gemini-2.0-flash-001',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        response_format: { type: 'json_object' },
      }),
    });

    if (!aiResponse.ok) {
      const errText = await aiResponse.text();
      console.error('AI API error:', errText);
      return new Response(
        JSON.stringify({ success: false, error: `AI analysis failed [${aiResponse.status}]` }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const aiData = await aiResponse.json();
    const content = aiData.choices?.[0]?.message?.content || '{}';

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      parsed = { message: content };
    }

    return new Response(
      JSON.stringify({ success: true, ...parsed, pageTitle }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('Error:', error);
    return new Response(
      JSON.stringify({ success: false, error: error instanceof Error ? error.message : 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
