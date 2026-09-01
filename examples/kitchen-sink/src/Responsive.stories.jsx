import React from 'react'

/**
 * A story whose layout depends only on the viewport width, so a run with
 * `widths` set produces two visibly different baselines and a run without it
 * produces one. If widths were ignored, both PNGs would say "Wide layout" and
 * the failure would be obvious rather than subtle.
 */

const CSS = `
  .tb-responsive {
    font: 14px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    border: 2px solid #1a1a1a;
    padding: 12px;
  }
  .tb-responsive .cards {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 8px;
    margin-top: 8px;
  }
  .tb-responsive .card {
    background: #e8f0fe;
    border: 1px solid #1a73e8;
    padding: 16px;
    text-align: center;
  }
  .tb-responsive .which::after { content: "Wide layout"; }

  @media (max-width: 600px) {
    .tb-responsive { border-color: #b00020; }
    .tb-responsive .cards { grid-template-columns: 1fr; }
    .tb-responsive .card { background: #fce8e6; border-color: #b00020; }
    .tb-responsive .which::after { content: "Narrow layout"; }
  }
`

const Responsive = () => (
  <div className="tb-responsive">
    <style>{CSS}</style>
    <strong className="which" />
    <div className="cards">
      <div className="card">One</div>
      <div className="card">Two</div>
      <div className="card">Three</div>
    </div>
  </div>
)

export default {
  title: 'Layout/Responsive',
  component: Responsive,
}

export const Cards = {}
