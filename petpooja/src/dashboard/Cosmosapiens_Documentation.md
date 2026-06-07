# पेटBOT — AI-Powered Restaurant Revenue Intelligence Platform

**Team Name:** Cosmosapiens  
**Team Members:** Luv Patel, Parth Shah, Nand Koradiya, Krish Bhoraniya, Param Desai  

---

# Overview

**पेटBOT** is an AI-powered **Restaurant Revenue Intelligence Platform** designed to help restaurant owners make smarter pricing, promotion, and menu decisions using real operational data instead of intuition.

Most restaurants operate without analytical visibility into:

- Menu profitability
- Price elasticity
- Customer ordering behaviour
- Peak demand windows

As a result, critical decisions are made using **gut feeling rather than data**.

पेटBOT solves this problem by transforming **raw restaurant data into actionable revenue intelligence** through three integrated modules:

1. Revenue Intelligence Dashboard  
2. AI Voice Ordering Agent  
3. Revenue Copilot Chatbot  

Together these modules help restaurants:

- Detect profitable hidden menu items
- Optimize menu pricing
- Increase average order value
- Identify peak demand hours
- Reduce missed revenue opportunities

---

# Problem Statement

Restaurants generate large amounts of operational data every day, but very few convert this into meaningful business intelligence.

### Menu Underperformance
Owners often cannot identify which dishes generate the highest **profit relative to kitchen effort**.

### Lack of Real-Time Intelligence
Promotions, pricing, and combo offers are usually based on guesswork rather than analytics.

### Missed Revenue Opportunities
Peak hours, trending dishes, and high-margin upsell opportunities often go unnoticed.

---

# Solution

पेटBOT converts restaurant operational data into **clear revenue signals and recommendations**.

The platform combines:

- Real-time analytics dashboards
- AI-powered conversational copilots
- Automated voice ordering with upsell intelligence

This allows restaurant owners to ask questions such as:

- Which items generate the highest profit?
- Which dishes should I promote tonight?
- Why are Monday revenues low?
- What items should I upsell during peak hours?

---

# System Architecture

The platform follows a **layered AI architecture** designed for scalability and modularity.

---

## Data Layer

Stores operational restaurant data and customer information.

Technologies used:

- PostgreSQL
- Redis
- Vector Store (RAG)

Stored data includes:

- Menu items
- Orders
- Pricing
- Revenue metrics
- Customer profiles
- Upsell rules

---

## Intelligence Layer

Responsible for all AI capabilities.

Components include:

- LLM engine (OpenAI / Groq)
- NL-to-SQL engine
- Retrieval Augmented Generation (RAG)
- Language detection
- Prompt templates

This layer converts **natural language queries into database insights**.

---

## Brain Layer

The **Brain Service** orchestrates all system intelligence.

Key services:

- Conversation State Machine
- Revenue Engine
- Upsell Recommendation Engine
- Context Summarizer
- Customer Identity Resolver

The brain handles both:

- Chat interactions
- Voice ordering conversations

---

## Interface Layer

User-facing components.

- Next.js Dashboard
- Voice Agent (Python + WebSocket)
- Revenue Copilot Chat
- POS integration adapter

---

# Platform Modules

---

# 1. Revenue Intelligence Dashboard

The dashboard provides **real-time insights into restaurant performance**.

Built with:

- Next.js 16
- React 19
- TypeScript
- ECharts

---

## KPI Cards

Five key performance indicators displayed at the top:

| KPI | Description |
|----|----|
| Total Revenue | Total earnings from orders |
| Best Day | Day with highest revenue |
| Peak Hour | Time window with maximum orders |
| Hidden Gold Count | High-margin under-promoted items |
| Top Trending Item | Fastest growing dish |

---

## Analytics Charts

The dashboard includes **six analytical visualizations**:

1. Menu Position Matrix  
2. Daily Revenue Trend  
3. Revenue by Day of Week  
4. Item Revenue Contribution  
5. Trending Items  
6. Peak Order Hours  

Each chart includes **plain-language insights explaining what action to take**.

---

# 2. AI Voice Ordering Agent

The AI Voice Agent automates restaurant phone orders.

Capabilities include:

- Speech-to-text processing
- Text-to-speech responses
- Multilingual support (English, Hindi, Hinglish)
- Fuzzy menu item matching
- Real-time upsell suggestions
- Automatic order confirmation

---

## Voice Ordering Flow

1. Customer calls restaurant
2. AI collects **name and phone number**
3. System retrieves **customer profile via RAG**
4. Personalized greeting is generated
5. Customer places order conversationally
6. Upsell engine suggests profitable items
7. Order confirmation occurs
8. Order stored in database

---

# 3. Revenue Copilot Chatbot

The Revenue Copilot allows restaurant owners to ask **natural language questions about their business**.

Example queries:

- "Which dishes generate the highest margin?"
- "Which combos should I promote?"
- "What are my peak hours?"
- "Which items are hidden gold?"

The chatbot uses **RAG + NL-to-SQL** to ensure responses are grounded in real data.

---

# Customer Intelligence System

The system builds **RAG-based customer profiles** from historical order data.

Each customer generates three types of documents:

### Customer Profile

Contains:

- Phone number
- Customer segment
- Visit count
- Total spending
- Preferred cuisine
- Last ordered items

---

### Personalized Greeting Script

The system dynamically generates greetings such as:

- Returning loyal customer greeting
- Returning regular greeting
- First-time customer welcome message

---

### Cuisine Preference Script

If a customer has ordered multiple times, the system can suggest their usual cuisine.

Example:

> "Last time you ordered Butter Chicken and Garlic Naan. Shall we go with Punjabi again today?"

---

# Brain Service

The **Brain Service** is the central orchestrator for all AI interactions.

It handles:

- Session management
- Customer identification
- Order processing
- Upsell logic
- Offer nudges
- Final order confirmation

The conversation follows a **state machine architecture**.

---

## Conversation States

| State | Purpose |
|------|------|
| Identity Collection | Collect name and phone |
| Greeting | Personalized greeting |
| Collecting Order | Customer ordering items |
| Clarifying | Resolve ambiguous requests |
| Awaiting Confirmation | Review order before placing |
| Processing | Writing order to database |
| Completed | Order finished |

---

# Upsell Recommendation Engine

The system uses multiple strategies to suggest additional items.

---

## Combo Upsell

If items are commonly ordered together:

Example:

> "Most customers who order Butter Chicken also add Garlic Naan."

---

## Offer Threshold Upsell

Encourages customers to reach discount thresholds.

Example:

> "You're only ₹60 away from getting 10% off your entire order."

---

## Hidden Gem Promotion

Promotes high-margin items with low popularity.

Example:

> "Our Tiramisu is a hidden gem — customers who try it love it!"

---

# Offer Engine

Two discount thresholds are implemented:

| Cart Value | Discount |
|----|----|
| ₹500 | 10% off |
| ₹900 | 20% off |

The system automatically:

- calculates discounts
- applies offers
- generates upsell nudges

---

# Tech Stack

## Frontend

- Next.js 16
- React 19
- TypeScript
- ECharts

---

## Backend

- Node.js
- PostgreSQL
- Redis
- BullMQ
- Docker

---

## AI Systems

- OpenAI / Groq LLMs
- Retrieval Augmented Generation (RAG)
- NL-to-SQL
- Vector embeddings
- Custom NLP pipeline

---

## Voice System

- Python STT pipeline
- Text-to-speech synthesis
- WebSocket voice server
- Twilio integration

---

# Project Structure
src/

brain/
brainService.ts
cartHelpers.ts

rag/
documentLoader.ts
vectorStore.ts
embedder.ts
documents/
retrievers/

conversation/
sessionStore.ts

upsell/
recommendationEngine.ts

ai/
promptTemplates.ts
llmClient.ts

dashboard/
app/
components/
lib/


---

# Quick Start

Clone the repository:


git clone <repo-url>


Install dependencies:


npm install


Run the development server:


npm run dev


Open:


http://localhost:3000


Revenue Copilot:


http://localhost:3000/revenue-copilot


---

# Example Revenue Outcomes

### Hidden Gold Promotion

Promoting **Tiramisu** can generate:

₹4,875 additional monthly margin.

---

### Price Optimization

Raising **Makki di Roti by ₹15** can generate:

₹4,500 additional revenue monthly.

---

### Peak Hour Stock Awareness

Preventing a Butter Chicken stockout during peak hours saves:

₹740 per service.

---

# Future Improvements

Potential enhancements include:

- POS integrations
- Dynamic pricing
- Inventory prediction
- Demand forecasting
- Multi-restaurant analytics
- Customer segmentation

---

# Conclusion

पेटBOT transforms restaurants from **intuition-driven businesses into data-driven operations**.

By combining analytics dashboards, AI copilots, and automated voice ordering, the platform enables restaurants to:

- increase average order value
- identify profitable opportunities
- optimize pricing strategies
- prevent missed revenue moments

Every chart, every recommendation, and every insight is designed with one goal:

**maximize restaurant revenue through intelligent data-driven decisions.**