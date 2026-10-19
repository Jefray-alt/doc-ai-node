import { Container, Stack, Text, Title } from '@mantine/core'

function App() {
  return (
    <Container component="main" size="sm" py="xl">
      <Stack gap="sm">
        <Title order={1}>Document Chat</Title>
        <Text c="dimmed">Your PDF conversation will appear here.</Text>
      </Stack>
    </Container>
  )
}

export default App
