// Sanadak (سندك): the Numrati assistant.
// It lives in Google Cloud as a Conversational Agents (Dialogflow CX) agent,
// with a playbook and a knowledge base (data store) of DVLD and Numrati files.
// This file sends the user's question to that agent and returns its answer.
//
// Sign-in: the server uses Google "Application Default Credentials".
// On a laptop that means running once:  gcloud auth application-default login
import dialogflow from '@google-cloud/dialogflow-cx'
import { env } from '../config/env.js'

const client = new dialogflow.SessionsClient()

const agentPath = `projects/${env.GCP_PROJECT_ID}/locations/${env.GCP_LOCATION}/agents/${env.GCP_AGENT_ID}`

// Always start in the Sanadak playbook (not the empty Default Start Flow)
const playbookPath = `${agentPath}/playbooks/${env.GCP_PLAYBOOK_ID}`

export async function askSanadak(sessionId: string, question: string, isNewChat: boolean) {
  const [response] = await client.detectIntent({
    session: `${agentPath}/sessions/${sessionId}`,
    queryInput: {
      text: { text: question },
      languageCode: env.GCP_LANGUAGE,
    },
    // Only point at the playbook on the first message, so the agent keeps its memory after that
    queryParams: isNewChat ? { currentPlaybook: playbookPath } : {},
  })

  // The agent can reply with several text messages; join them into one answer
  const parts: string[] = []
  for (const message of response.queryResult?.responseMessages ?? []) {
    for (const line of message.text?.text ?? []) {
      if (line.trim()) parts.push(line.trim())
    }
  }
  return parts.join('\n\n')
}
