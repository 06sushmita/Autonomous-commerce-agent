/**
 * Autonomous Commerce Agent (ACA) - Landing Page
 *
 * Theme Specification:
 * - Background: Warm ivory / off-white (#FBF9F5, #FAF8F5)
 * - Structural Elements (Header/Nav/Footer): Deep charcoal (#18191B)
 * - Primary Accent: Muted orange (#E05A1C - Swiggy warmth)
 * - Secondary Accent: Soft violet (#7C5CFC - Zepto touch)
 * - Biometric / Security: Deep teal (#0D9488 - Prava AP2)
 * - Typography: Inter, Plus Jakarta Sans, JetBrains Mono
 * - Cards: Flat, subtle borders (1px solid rgba(0, 0, 0, 0.08))
 * - Buttons: Simple, solid colors (no heavy multi-stop gradients)
 * - Layout: Spacious, structured, editorial elegance
 */

export function renderLandingPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Autonomous Commerce Agent — Real-Time Grocery AI Copilot</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&family=Plus+Jakarta+Sans:wght@500;600;700;800&display=swap" rel="stylesheet">
  <style>
    :root {
      /* Warm Ivory & Deep Charcoal Editorial Palette */
      --bg: #FBF9F5;
      --bg-canvas: #FAF8F5;
      --bg-alt: #F4F1EA;
      --card-bg: #FFFFFF;
      --card-border: rgba(0, 0, 0, 0.08);
      --card-border-hover: rgba(224, 90, 28, 0.4);

      /* Structural Elements: Deep Charcoal */
      --header-bg: #18191B;
      --header-border: rgba(255, 255, 255, 0.08);
      --header-text: #F9FAFB;
      --charcoal: #18191B;
      --charcoal-hover: #26292E;

      /* Primary Accent: Muted Orange (Swiggy Warmth) */
      --primary: #E05A1C;
      --primary-hover: #C84E14;
      --primary-light: rgba(224, 90, 28, 0.08);
      --swiggy: #E05A1C;
      --swiggy-glow: rgba(224, 90, 28, 0.12);

      /* Secondary Accent: Soft Violet (Zepto Touch) */
      --secondary: #7C5CFC;
      --secondary-hover: #6944F3;
      --secondary-light: rgba(124, 92, 252, 0.08);
      --zepto: #7C5CFC;
      --zepto-glow: rgba(124, 92, 252, 0.12);

      /* Security & Biometrics: Deep Teal */
      --prava: #0D9488;
      --prava-light: rgba(13, 148, 136, 0.1);

      /* Typography & Text */
      --text: #18191B;
      --text-muted: #5B616E;
      --text-dim: #8E95A5;
      --surface-subtle: #F5F2EB;
      --surface-border: rgba(0, 0, 0, 0.06);

      /* Geometry & Elevation */
      --radius-sm: 8px;
      --radius-md: 12px;
      --radius-lg: 16px;
      --shadow-sm: 0 1px 3px rgba(0, 0, 0, 0.04), 0 1px 2px rgba(0, 0, 0, 0.02);
      --shadow-md: 0 4px 16px rgba(0, 0, 0, 0.05);
      --shadow-lg: 0 12px 36px rgba(0, 0, 0, 0.08);
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }
    html { scroll-behavior: smooth; }
    body {
      background-color: var(--bg);
      background-image:
        radial-gradient(at 100% 0%, rgba(224, 90, 28, 0.035) 0px, transparent 50%),
        radial-gradient(at 0% 100%, rgba(124, 92, 252, 0.03) 0px, transparent 50%);
      color: var(--text);
      font-family: 'Inter', 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      overflow-x: hidden;
      -webkit-font-smoothing: antialiased;
    }

    /* Top Navigation */
    header {
      background: var(--header-bg);
      border-bottom: 1px solid var(--header-border);
      position: sticky;
      top: 0;
      z-index: 100;
      padding: 16px 36px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 20px;
      box-shadow: 0 2px 12px rgba(0, 0, 0, 0.15);
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
      text-decoration: none;
    }
    .brand-logo {
      width: 38px;
      height: 38px;
      border-radius: var(--radius-sm);
      background: var(--primary);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 20px;
      color: #fff;
    }
    .brand-text h1 {
      font-size: 16px;
      font-weight: 700;
      letter-spacing: -0.01em;
      color: #FFFFFF;
    }
    .brand-text p {
      font-size: 11px;
      color: #9CA3AF;
      font-weight: 500;
    }
    .nav-links {
      display: flex;
      align-items: center;
      gap: 28px;
    }
    .nav-link {
      font-size: 13px;
      font-weight: 600;
      color: #D1D5DB;
      text-decoration: none;
      transition: color 0.15s ease;
    }
    .nav-link:hover {
      color: #FFFFFF;
    }
    .nav-actions {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .btn-nav-outline {
      background: rgba(255, 255, 255, 0.08);
      border: 1px solid rgba(255, 255, 255, 0.15);
      color: #FFF;
      padding: 8px 16px;
      border-radius: var(--radius-sm);
      font-size: 12px;
      font-weight: 600;
      text-decoration: none;
      transition: all 0.15s ease;
    }
    .btn-nav-outline:hover {
      background: rgba(255, 255, 255, 0.15);
    }
    .btn-nav-primary {
      background: var(--primary);
      color: #FFF;
      padding: 8px 18px;
      border-radius: var(--radius-sm);
      font-size: 12px;
      font-weight: 700;
      text-decoration: none;
      transition: background-color 0.15s ease;
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .btn-nav-primary:hover {
      background: var(--primary-hover);
    }

    /* Hero Section */
    .hero-section {
      max-width: 1140px;
      width: 100%;
      margin: 0 auto;
      padding: 72px 24px 48px 24px;
      text-align: center;
      display: flex;
      flex-direction: column;
      align-items: center;
    }
    .hero-badge {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      background: #FFFFFF;
      border: 1px solid var(--card-border);
      padding: 6px 16px;
      border-radius: 20px;
      font-size: 11px;
      font-weight: 700;
      color: var(--charcoal);
      letter-spacing: 0.04em;
      text-transform: uppercase;
      margin-bottom: 24px;
      box-shadow: var(--shadow-sm);
    }
    .hero-badge .dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--primary);
    }
    .hero-title {
      font-size: 52px;
      font-weight: 800;
      line-height: 1.15;
      letter-spacing: -0.025em;
      color: var(--text);
      max-width: 900px;
      margin-bottom: 20px;
    }
    .hero-title span.highlight-swiggy {
      color: var(--primary);
    }
    .hero-title span.highlight-zepto {
      color: var(--secondary);
    }
    .hero-subtitle {
      font-size: 18px;
      line-height: 1.6;
      color: var(--text-muted);
      max-width: 720px;
      margin-bottom: 36px;
    }
    .hero-cta-group {
      display: flex;
      align-items: center;
      gap: 14px;
      flex-wrap: wrap;
      justify-content: center;
      margin-bottom: 48px;
    }
    .btn-hero-primary {
      background: var(--primary);
      color: #FFF;
      padding: 15px 32px;
      border-radius: var(--radius-sm);
      font-size: 15px;
      font-weight: 700;
      text-decoration: none;
      transition: background-color 0.15s ease;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      box-shadow: var(--shadow-sm);
    }
    .btn-hero-primary:hover {
      background: var(--primary-hover);
    }
    .btn-hero-secondary {
      background: #FFFFFF;
      border: 1px solid var(--card-border);
      color: var(--text);
      padding: 15px 28px;
      border-radius: var(--radius-sm);
      font-size: 15px;
      font-weight: 600;
      text-decoration: none;
      transition: all 0.15s ease;
      display: inline-flex;
      align-items: center;
      gap: 8px;
    }
    .btn-hero-secondary:hover {
      background: var(--surface-subtle);
      border-color: rgba(0, 0, 0, 0.15);
    }

    /* Live Interactive Teaser Card */
    .hero-preview-wrapper {
      max-width: 960px;
      width: 100%;
      background: #FFFFFF;
      border: 1px solid var(--card-border);
      border-radius: var(--radius-lg);
      box-shadow: var(--shadow-lg);
      overflow: hidden;
      text-align: left;
    }
    .preview-header-bar {
      background: var(--charcoal);
      padding: 12px 20px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    }
    .mac-dots {
      display: flex;
      gap: 6px;
    }
    .mac-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: rgba(255, 255, 255, 0.2);
    }
    .preview-bar-title {
      font-size: 11px;
      font-weight: 600;
      color: #9CA3AF;
      font-family: 'JetBrains Mono', monospace;
    }
    .preview-body {
      padding: 24px;
      background: #FAF8F5;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    .preview-user-query {
      align-self: flex-end;
      background: var(--charcoal);
      color: #FFF;
      padding: 12px 18px;
      border-radius: var(--radius-md);
      border-bottom-right-radius: 4px;
      font-size: 13px;
      font-weight: 500;
      max-width: 80%;
    }
    .preview-agent-card {
      background: #FFFFFF;
      border: 1px solid var(--card-border);
      border-left: 4px solid var(--primary);
      border-radius: var(--radius-md);
      padding: 18px 22px;
      box-shadow: var(--shadow-sm);
    }
    .preview-top-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 12px;
      flex-wrap: wrap;
      gap: 8px;
    }
    .preview-badge-group {
      display: flex;
      gap: 8px;
      align-items: center;
    }
    .preview-badge {
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      padding: 3px 8px;
      border-radius: 4px;
    }
    .preview-item-row {
      display: flex;
      align-items: center;
      gap: 16px;
      padding: 12px 0;
      border-top: 1px solid var(--card-border);
      border-bottom: 1px solid var(--card-border);
    }
    .preview-item-img {
      width: 52px;
      height: 52px;
      background: var(--bg);
      border-radius: 6px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 26px;
      border: 1px solid var(--card-border);
    }
    .preview-action-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-top: 14px;
      gap: 12px;
      flex-wrap: wrap;
    }

    /* Stats Strip */
    .stats-section {
      border-top: 1px solid var(--card-border);
      border-bottom: 1px solid var(--card-border);
      background: #FFFFFF;
      padding: 36px 24px;
    }
    .stats-grid {
      max-width: 1140px;
      margin: 0 auto;
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 24px;
      text-align: center;
    }
    @media (max-width: 768px) {
      .stats-grid { grid-template-columns: repeat(2, 1fr); }
      .hero-title { font-size: 36px; }
      .nav-links { display: none; }
    }
    .stat-number {
      font-size: 32px;
      font-weight: 800;
      color: var(--text);
      letter-spacing: -0.02em;
    }
    .stat-label {
      font-size: 13px;
      font-weight: 600;
      color: var(--text-muted);
      margin-top: 4px;
    }

    /* Section Styling */
    .section-container {
      max-width: 1140px;
      width: 100%;
      margin: 0 auto;
      padding: 80px 24px;
    }
    .section-header {
      text-align: center;
      max-width: 700px;
      margin: 0 auto 52px auto;
    }
    .section-tag {
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--primary);
      margin-bottom: 8px;
    }
    .section-title {
      font-size: 34px;
      font-weight: 800;
      letter-spacing: -0.02em;
      color: var(--text);
      margin-bottom: 14px;
    }
    .section-desc {
      font-size: 16px;
      color: var(--text-muted);
      line-height: 1.6;
    }

    /* How It Works (3 Steps) */
    .steps-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 24px;
    }
    @media (max-width: 768px) {
      .steps-grid { grid-template-columns: 1fr; }
    }
    .step-card {
      background: #FFFFFF;
      border: 1px solid var(--card-border);
      border-radius: var(--radius-md);
      padding: 32px 26px;
      box-shadow: var(--shadow-sm);
      display: flex;
      flex-direction: column;
      gap: 14px;
      position: relative;
    }
    .step-number {
      width: 32px;
      height: 32px;
      border-radius: var(--radius-sm);
      background: var(--charcoal);
      color: #FFF;
      font-size: 14px;
      font-weight: 800;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .step-title {
      font-size: 18px;
      font-weight: 700;
      color: var(--text);
    }
    .step-desc {
      font-size: 14px;
      color: var(--text-muted);
      line-height: 1.6;
    }

    /* Feature Grid (Flat, Subtle Borders) */
    .features-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 24px;
    }
    @media (max-width: 900px) {
      .features-grid { grid-template-columns: repeat(2, 1fr); }
    }
    @media (max-width: 600px) {
      .features-grid { grid-template-columns: 1fr; }
    }
    .feature-card {
      background: #FFFFFF;
      border: 1px solid var(--card-border);
      border-radius: var(--radius-md);
      padding: 28px 24px;
      box-shadow: var(--shadow-sm);
      transition: border-color 0.15s ease, box-shadow 0.15s ease;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .feature-card:hover {
      border-color: rgba(224, 90, 28, 0.4);
      box-shadow: var(--shadow-md);
    }
    .feature-icon-box {
      width: 44px;
      height: 44px;
      border-radius: var(--radius-sm);
      background: var(--surface-subtle);
      border: 1px solid var(--card-border);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 22px;
      color: var(--charcoal);
    }
    .feature-title {
      font-size: 17px;
      font-weight: 700;
      color: var(--text);
    }
    .feature-desc {
      font-size: 13.5px;
      color: var(--text-muted);
      line-height: 1.6;
    }

    /* Live Comparison Showcase (User-Friendly & Professional) */
    .comparison-wrapper {
      background: #FFFFFF;
      border: 1px solid var(--card-border);
      border-radius: var(--radius-lg);
      padding: 32px;
      box-shadow: var(--shadow-sm);
    }
    .comparison-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 24px;
      margin-bottom: 24px;
    }
    @media (max-width: 768px) {
      .comparison-grid { grid-template-columns: 1fr; }
    }
    .store-compare-card {
      background: var(--bg);
      border: 1px solid var(--card-border);
      border-radius: var(--radius-md);
      padding: 22px;
      display: flex;
      flex-direction: column;
      gap: 14px;
      position: relative;
    }
    .store-compare-card.winner-card {
      border: 2px solid var(--primary);
      background: #FFFDF9;
    }
    .store-compare-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .store-brand-pill {
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      padding: 4px 10px;
      border-radius: 4px;
      letter-spacing: 0.04em;
    }
    .store-eta-pill {
      font-size: 11px;
      font-weight: 700;
      color: var(--text);
      background: #FFFFFF;
      border: 1px solid var(--card-border);
      padding: 4px 10px;
      border-radius: 4px;
    }
    .compare-item-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .compare-item-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 13px;
      color: var(--text);
      padding: 6px 0;
      border-bottom: 1px dashed rgba(0, 0, 0, 0.08);
    }
    .compare-total-row {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      padding-top: 8px;
      font-weight: 800;
      font-size: 18px;
      color: var(--text);
    }
    .comparison-winner-banner {
      background: #FDF4E7;
      border: 1px solid rgba(224, 90, 28, 0.25);
      border-radius: var(--radius-md);
      padding: 16px 20px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 14px;
    }
    .comparison-pillars {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 16px;
      margin-top: 24px;
      padding-top: 24px;
      border-top: 1px solid var(--card-border);
    }
    @media (max-width: 900px) {
      .comparison-pillars { grid-template-columns: repeat(2, 1fr); }
    }
    @media (max-width: 600px) {
      .comparison-pillars { grid-template-columns: 1fr; }
    }
    .pillar-item {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .pillar-title {
      font-size: 13px;
      font-weight: 700;
      color: var(--text);
    }
    .pillar-desc {
      font-size: 12px;
      color: var(--text-muted);
      line-height: 1.5;
    }

    /* FAQ Section */
    .faq-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 20px;
    }
    @media (max-width: 768px) {
      .faq-grid { grid-template-columns: 1fr; }
    }
    .faq-card {
      background: #FFFFFF;
      border: 1px solid var(--card-border);
      border-radius: var(--radius-md);
      padding: 24px;
      box-shadow: var(--shadow-sm);
    }
    .faq-q {
      font-size: 15px;
      font-weight: 700;
      color: var(--text);
      margin-bottom: 8px;
    }
    .faq-a {
      font-size: 13.5px;
      color: var(--text-muted);
      line-height: 1.6;
    }

    /* Bottom CTA Strip */
    .cta-banner {
      background: var(--charcoal);
      border-radius: var(--radius-lg);
      padding: 56px 40px;
      text-align: center;
      color: #FFF;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 20px;
      box-shadow: var(--shadow-lg);
      margin-bottom: 40px;
    }
    .cta-banner h2 {
      font-size: 34px;
      font-weight: 800;
      letter-spacing: -0.02em;
    }
    .cta-banner p {
      font-size: 16px;
      color: #9CA3AF;
      max-width: 600px;
      line-height: 1.6;
    }

    /* Footer */
    footer {
      background: var(--header-bg);
      border-top: 1px solid var(--header-border);
      padding: 40px 36px 30px 36px;
      color: #9CA3AF;
      font-size: 12px;
      margin-top: auto;
    }
    .footer-content {
      max-width: 1140px;
      margin: 0 auto;
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 20px;
    }
    .footer-left {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .footer-links {
      display: flex;
      gap: 24px;
    }
    .footer-link {
      color: #D1D5DB;
      text-decoration: none;
      transition: color 0.15s ease;
    }
    .footer-link:hover {
      color: #FFFFFF;
    }
  </style>
</head>
<body>
  <!-- Header -->
  <header>
    <a href="/" class="brand">
      <div class="brand-logo">⚡</div>
      <div class="brand-text">
        <h1>Autonomous Commerce Agent</h1>
        <p>Swiggy & Zepto Real-Time Ordering</p>
      </div>
    </a>

    <div class="nav-links">
      <a href="#how-it-works" class="nav-link">How It Works</a>
      <a href="#features" class="nav-link">Key Features</a>
      <a href="#live-comparison" class="nav-link">Live Comparison</a>
      <a href="#security" class="nav-link">Passkey Security</a>
      <a href="#faq" class="nav-link">FAQ</a>
    </div>

    <div class="nav-actions">
      <a href="/app?action=signin" class="btn-nav-outline">Sign In</a>
      <a href="/app" class="btn-nav-primary">Launch Copilot ➔</a>
    </div>
  </header>

  <!-- Hero Section -->
  <section class="hero-section">
    <div class="hero-badge">
      <span class="dot"></span>
      ⚡ Real-Time Price Comparison & 10-Minute Delivery
    </div>

    <h1 class="hero-title">
      Autonomous Grocery Ordering, Powered by <span class="highlight-swiggy">Swiggy</span> & <span class="highlight-zepto">Zepto</span>.
    </h1>

    <p class="hero-subtitle">
      Your personal AI shopping copilot discovers local dark stores, compares real-time prices & 10-minute ETAs, spotlights <b>The One Best Choice</b>, and lets you check out in seconds with Google sign-in or Touch ID / Face ID passkeys.
    </p>

    <div class="hero-cta-group">
      <a href="/app" class="btn-hero-primary">Launch Shopping Copilot ➔</a>
      <a href="#live-comparison" class="btn-hero-secondary">View Live Comparison ↓</a>
    </div>

    <!-- Live Preview Interactive Showcase Card -->
    <div class="hero-preview-wrapper">
      <div class="preview-header-bar">
        <div class="mac-dots">
          <div class="mac-dot"></div>
          <div class="mac-dot"></div>
          <div class="mac-dot"></div>
        </div>
        <div class="preview-bar-title">autonomous-commerce-agent // live shopping turn</div>
        <div style="font-size:11px; color:#10B981; font-weight:600;">● Online (Local Dark Stores)</div>
      </div>

      <div class="preview-body">
        <div class="preview-user-query">
          "Find me 1L Nandini toned milk and brown bread in under 15 mins"
        </div>

        <div class="preview-agent-card">
          <div class="preview-top-row">
            <div class="preview-badge-group">
              <span class="preview-badge" style="background:var(--primary); color:#FFF;">🏆 AGENT TOP CHOICE</span>
              <span class="preview-badge" style="background:#ECFDF5; border:1px solid #A7F3D0; color:#047857;">✓ 5 CONSTRAINTS VERIFIED</span>
              <span class="preview-badge" style="background:rgba(224,90,28,0.12); border:1px solid rgba(224,90,28,0.3); color:var(--primary);">● Swiggy Instamart</span>
            </div>
            <span style="font-size:11px; font-weight:700; color:var(--charcoal); background:var(--surface-subtle); padding:3px 8px; border-radius:4px;">⚡ 12 MINS DELIVERY</span>
          </div>

          <div class="preview-item-row">
            <div class="preview-item-img">🥛</div>
            <div style="flex:1;">
              <div style="font-size:10px; font-weight:700; color:var(--primary); text-transform:uppercase;">Nandini Milk</div>
              <div style="font-size:15px; font-weight:700; color:var(--text);">Nandini Special Pasteurized Toned Fresh Milk</div>
              <div style="font-size:11px; color:var(--text-muted);">Size / Variant: <b>1 Litre Pouch</b></div>
            </div>
            <div style="text-align:right;">
              <div style="font-size:18px; font-weight:800; color:var(--text);">₹46.00</div>
              <div style="font-size:11px; color:var(--text-dim); text-decoration:line-through;">₹50.00</div>
            </div>
          </div>

          <div class="preview-action-row">
            <div style="font-size:12px; color:var(--text-muted);">
              Ordering on behalf of <b>Active Verified User</b> • Remaining Daily Limit: <b>₹4,954.00</b>
            </div>
            <a href="/app" class="btn-nav-primary" style="padding:10px 18px; font-size:12px;">
              🔒 Authorize with Biometric Passkey
            </a>
          </div>
        </div>
      </div>
    </div>
  </section>

  <!-- Live Metrics Strip -->
  <section class="stats-section">
    <div class="stats-grid">
      <div>
        <div class="stat-number">10–15 Mins</div>
        <div class="stat-label">Guaranteed Quick Delivery</div>
      </div>
      <div>
        <div class="stat-number">2 Active MCPs</div>
        <div class="stat-label">Swiggy Instamart & Zepto SSE</div>
      </div>
      <div>
        <div class="stat-number">100% Cryptographic</div>
        <div class="stat-label">Prava AP2 Touch ID / Face ID</div>
      </div>
      <div>
        <div class="stat-number">₹0 Overspend</div>
        <div class="stat-label">Atomic Neon DB Spend Guardrails</div>
      </div>
    </div>
  </section>

  <!-- How It Works -->
  <section class="section-container" id="how-it-works">
    <div class="section-header">
      <div class="section-tag">Autonomous Workflow</div>
      <h2 class="section-title">How Autonomous Grocery Ordering Works</h2>
      <p class="section-desc">
        Three simple phases transform a conversational shopping prompt into an autonomously dispatched quick-commerce order.
      </p>
    </div>

    <div class="steps-grid">
      <div class="step-card">
        <div class="step-number">1</div>
        <h3 class="step-title">Conversational Intent</h3>
        <p class="step-desc">
          State what you need in plain English (e.g. <i>"1L milk and eggs under ₹150 in under 15m"</i>). The agent parses quantities, cost thresholds, and urgency.
        </p>
      </div>

      <div class="step-card">
        <div class="step-number">2</div>
        <h3 class="step-title">Parallel MCP Sourcing</h3>
        <p class="step-desc">
          The agent queries both Swiggy Instamart and Zepto dark stores simultaneously, verifies real-time stock, filters by 5 strict constraints, and isolates the lowest total basket price.
        </p>
      </div>

      <div class="step-card">
        <div class="step-number">3</div>
        <h3 class="step-title">Biometric Execution</h3>
        <p class="step-desc">
          The agent creates an AP2 CartMandate. You authorize with Touch ID or Face ID passkey. Prava issues a single-use token, atomic budget is reserved, and couriers dispatch immediately.
        </p>
      </div>
    </div>
  </section>

  <!-- Core Capabilities Grid -->
  <section class="section-container" style="background:#FAF8F5; border-top:1px solid var(--card-border); border-bottom:1px solid var(--card-border);" id="features">
    <div class="section-header">
      <div class="section-tag">Key Innovations</div>
      <h2 class="section-title">Engineered for Autonomous Trust</h2>
      <p class="section-desc">
        Engineered for speed, savings, and peace of mind with real-time merchant integrations and biometric security.
      </p>
    </div>

    <div class="features-grid">
      <div class="feature-card">
        <div class="feature-icon-box">⚡</div>
        <h3 class="feature-title">Swiggy & Zepto MCPs</h3>
        <p class="feature-desc">
          Direct streamable HTTP/SSE connections to official quick-commerce merchant servers. Eliminates scraping, fragile web automations, and stale price caching.
        </p>
      </div>

      <div class="feature-card">
        <div class="feature-icon-box">🏆</div>
        <h3 class="feature-title">"The One Best Choice"</h3>
        <p class="feature-desc">
          Instead of overwhelming you with endless catalogs, the agent calculates per-unit prices, delivery fees, and ETAs to spotlight the single best option with direct merchant deep links.
        </p>
      </div>

      <div class="feature-card">
        <div class="feature-icon-box">🔒</div>
        <h3 class="feature-title">Prava AP2 Biometrics</h3>
        <p class="feature-desc">
          FIDO2 WebAuthn passkey protocol ensures the AI agent can never transfer money or finalize a checkout without explicit hardware biometric confirmation from you.
        </p>
      </div>

      <div class="feature-card">
        <div class="feature-icon-box">📍</div>
        <h3 class="feature-title">Dynamic GPS Geocoding</h3>
        <p class="feature-desc">
          One-click browser GPS or custom Indian address & 6-digit pincode routing. Connects dynamically to dark stores across Bengaluru, Mumbai MMR, Delhi NCR, and beyond.
        </p>
      </div>

      <div class="feature-card">
        <div class="feature-icon-box">🛡️</div>
        <h3 class="feature-title">Daily Budget Limits</h3>
        <p class="feature-desc">
          Configure a daily spend limit (e.g. ₹5,000/day). Neon PostgreSQL enforces rolling 24-hour spend ceilings with atomic reservations and automatic refunds on failed attempts.
        </p>
      </div>

      <div class="feature-card">
        <div class="feature-icon-box">🔑</div>
        <h3 class="feature-title">Sign In with Google & 1-Click Access</h3>
        <p class="feature-desc">
          Sign in seamlessly with Google or your verified account. Your saved delivery addresses, preferred grocery items, and daily wallet allowances stay private and synced.
        </p>
      </div>
    </div>
  </section>

  <!-- Live Multi-Store Price Comparison Showcase -->
  <section class="section-container" id="live-comparison">
    <div class="section-header">
      <div class="section-tag">Real-Time Intelligence</div>
      <h2 class="section-title">Side-by-Side Multi-Store Comparison</h2>
      <p class="section-desc">
        Never overpay or wait longer than necessary. The autonomous copilot monitors live inventory across both Swiggy Instamart and Zepto to surface maximum savings and fastest delivery.
      </p>
    </div>

    <div class="comparison-wrapper">
      <div style="font-size: 13px; font-weight: 700; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 16px;">
        🔍 Live Shopping Request: "1L Fresh Toned Milk & Whole Wheat Bread in under 15 mins"
      </div>

      <div class="comparison-grid">
        <!-- Swiggy Instamart Card -->
        <div class="store-compare-card winner-card">
          <div class="store-compare-header">
            <span class="store-brand-pill" style="background: rgba(224, 90, 28, 0.12); color: var(--swiggy); border: 1px solid rgba(224, 90, 28, 0.3);">
              ● Swiggy Instamart
            </span>
            <span class="store-eta-pill">⚡ 12 Mins Delivery</span>
          </div>

          <div class="compare-item-list">
            <div class="compare-item-row">
              <span>🥛 Nandini Special Toned Milk (1 Litre)</span>
              <b>₹46.00</b>
            </div>
            <div class="compare-item-row">
              <span>🍞 English Oven 100% Whole Wheat Bread (400g)</span>
              <b>₹45.00</b>
            </div>
            <div class="compare-item-row" style="color: var(--text-muted); font-size: 12px;">
              <span>Delivery & Handling Fee</span>
              <span>₹4.00</span>
            </div>
          </div>

          <div class="compare-total-row">
            <span>Total Basket</span>
            <span style="color: var(--swiggy);">₹95.00</span>
          </div>

          <div style="font-size: 11px; font-weight: 700; color: #047857; background: #ECFDF5; border: 1px solid #A7F3D0; padding: 6px 10px; border-radius: 4px; text-align: center;">
            🏆 <b>The One Best Choice Selected</b> — Lowest Total Basket Price
          </div>
        </div>

        <!-- Zepto Card -->
        <div class="store-compare-card">
          <div class="store-compare-header">
            <span class="store-brand-pill" style="background: rgba(124, 92, 252, 0.12); color: var(--zepto); border: 1px solid rgba(124, 92, 252, 0.3);">
              ● Zepto
            </span>
            <span class="store-eta-pill">⚡ 16 Mins Delivery</span>
          </div>

          <div class="compare-item-list">
            <div class="compare-item-row">
              <span>🥛 Nandini Special Toned Milk (1 Litre)</span>
              <b>₹48.00</b>
            </div>
            <div class="compare-item-row">
              <span>🍞 The Health Factory Zero Maida Bread (400g)</span>
              <b>₹48.00</b>
            </div>
            <div class="compare-item-row" style="color: var(--text-muted); font-size: 12px;">
              <span>Delivery & Handling Fee</span>
              <span>₹3.00</span>
            </div>
          </div>

          <div class="compare-total-row">
            <span>Total Basket</span>
            <span style="color: var(--zepto);">₹99.00</span>
          </div>

          <div style="font-size: 11px; color: var(--text-muted); background: #FFFFFF; border: 1px solid var(--card-border); padding: 6px 10px; border-radius: 4px; text-align: center;">
            Available in Local Dark Store • Standard Dispatch
          </div>
        </div>
      </div>

      <!-- Winner Summary Banner -->
      <div class="comparison-winner-banner">
        <div>
          <div style="font-size: 14px; font-weight: 700; color: var(--text);">
            💡 AI Copilot Decision: Instant ₹4.00 Savings + 4 Minutes Faster Delivery
          </div>
          <div style="font-size: 12px; color: var(--text-muted); margin-top: 2px;">
            The agent autonomously factors item variant size, store inventory, delivery fee waivers, and courier availability.
          </div>
        </div>
        <a href="/app" class="btn-nav-primary" style="padding: 10px 20px; font-size: 13px;">
          Try Live Shopping Copilot ➔
        </a>
      </div>

      <!-- 4 Pillars of Consumer Trust -->
      <div class="comparison-pillars">
        <div class="pillar-item">
          <div class="pillar-title">🛒 100% Real-Time Stock</div>
          <div class="pillar-desc">Live dark store synchronization guarantees products are on store shelves before cart assembly.</div>
        </div>
        <div class="pillar-item">
          <div class="pillar-title">⚡ 10–15 Mins Delivery</div>
          <div class="pillar-desc">Dynamic hyperlocal routing connects to the nearest dispatch hub in your neighborhood.</div>
        </div>
        <div class="pillar-item">
          <div class="pillar-title">🔒 Hardware Biometrics</div>
          <div class="pillar-desc">Checkout execution is cryptographically bound to Touch ID or Face ID passkeys on your device.</div>
        </div>
        <div class="pillar-item">
          <div class="pillar-title">🛡️ Zero Overspend</div>
          <div class="pillar-desc">Customizable daily allowances safeguard your household grocery budget automatically.</div>
        </div>
      </div>
    </div>
  </section>

  <!-- Security & Passkeys Focus -->
  <section class="section-container" style="background:#FAF8F5; border-top:1px solid var(--card-border); border-bottom:1px solid var(--card-border);" id="security">
    <div class="section-header">
      <div class="section-tag">Cryptographic Assurance</div>
      <h2 class="section-title">Why Passkeys Change Agentic Commerce</h2>
      <p class="section-desc">
        Traditional card numbers and static OTPs are unsafe when delegated to autonomous software. Prava AP2 solves this with hardware-bound biometric authentication.
      </p>
    </div>

    <div class="steps-grid">
      <div class="step-card">
        <div style="font-size:28px;">🔑</div>
        <h3 class="step-title">Hardware-Bound FIDO2</h3>
        <p class="step-desc">
          Your private key never leaves your device's Secure Enclave. Touch ID or Face ID generates an ephemeral signature that only validates the exact order mandate.
        </p>
      </div>

      <div class="step-card">
        <div style="font-size:28px;">🛡️</div>
        <h3 class="step-title">Single-Use Tokens</h3>
        <p class="step-desc">
          Each order generates an isolated <code>prava_token_ref</code>. Tokens expire immediately once consumed, making replay attacks mathematically impossible.
        </p>
      </div>

      <div class="step-card">
        <div style="font-size:28px;">💳</div>
        <h3 class="step-title">Atomic Spend Invariants</h3>
        <p class="step-desc">
          Concurrent requests cannot drain your budget. Funds are atomically reserved and either committed upon dispatch or instantly released if the merchant rejects the cart.
        </p>
      </div>
    </div>
  </section>

  <!-- FAQ Section -->
  <section class="section-container" id="faq">
    <div class="section-header">
      <div class="section-tag">Common Questions</div>
      <h2 class="section-title">Frequently Asked Questions</h2>
      <p class="section-desc">
        Everything you need to know about autonomous quick-commerce ordering with Swiggy and Zepto.
      </p>
    </div>

    <div class="faq-grid">
      <div class="faq-card">
        <h3 class="faq-q">Can the AI agent place orders without my permission?</h3>
        <p class="faq-a">
          No. The agent can search, compare baskets, and assemble mandates autonomously, but checkout execution is strictly blocked until you authenticate with your Touch ID / Face ID passkey.
        </p>
      </div>

      <div class="faq-card">
        <h3 class="faq-q">What happens if an item is out of stock?</h3>
        <p class="faq-a">
          The agent queries live dark store inventories in real time. If an item is sold out on Swiggy Instamart, the agent automatically surfaces available stock from Zepto (and vice versa).
        </p>
      </div>

      <div class="faq-card">
        <h3 class="faq-q">Can I modify my daily spend limit?</h3>
        <p class="faq-a">
          Yes. You can adjust your daily spend ceiling anytime inside the Wallet modal. Changes are saved instantly to your Neon PostgreSQL profile and enforced on all subsequent orders.
        </p>
      </div>

      <div class="faq-card">
        <h3 class="faq-q">Where does the agent deliver?</h3>
        <p class="faq-a">
          Anywhere covered by Swiggy Instamart and Zepto dark stores across India. The agent supports GPS auto-detection as well as custom address and 6-digit pincode entry.
        </p>
      </div>
    </div>
  </section>

  <!-- Bottom CTA Strip -->
  <section class="section-container" style="padding-top:20px;">
    <div class="cta-banner">
      <h2>Experience Autonomous Commerce Today</h2>
      <p>
        Try conversational grocery ordering across Swiggy Instamart and Zepto. Discover real-time pricing, compare dark store delivery speeds, and authorize with biometrics.
      </p>
      <a href="/app" class="btn-hero-primary" style="background:#FFFFFF; color:var(--charcoal); font-size:16px; padding:16px 36px;">
        Launch Agent Copilot ➔
      </a>
    </div>
  </section>

  <!-- Footer -->
  <footer>
    <div class="footer-content">
      <div class="footer-left">
        <span style="font-size:18px;">⚡</span>
        <span style="color:#FFF; font-weight:700;">Autonomous Commerce Agent</span>
        <span>•</span>
        <span>Hyperlocal Grocery Delivery via Swiggy Instamart & Zepto</span>
      </div>

      <div class="footer-links">
        <a href="/app" class="footer-link">Commerce Copilot</a>
        <a href="#how-it-works" class="footer-link">How It Works</a>
        <a href="#features" class="footer-link">Key Features</a>
        <a href="#live-comparison" class="footer-link">Live Comparison</a>
        <a href="#security" class="footer-link">Passkey Security</a>
        <a href="#faq" class="footer-link">FAQ</a>
      </div>
    </div>
  </footer>
</body>
</html>`;
}
