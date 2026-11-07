def oddSum : Nat → Nat
  | 0 => 0
  | n + 1 => oddSum n + (2 * n + 1)

theorem oddSum_eq (n : Nat) : oddSum n = n * n := by
  sorry

-- On an island every inhabitant is a knight (always tells the truth, `true`)
-- or a knave (always lies, `false`). A says "B is a knave". B says "A and C
-- are the same kind". C says "B is a knight, or A is a knave".
def island (a b c : Bool) : Bool :=
  (a == !b) && (b == (a == c)) && (c == (b || !a))

-- Fill in who is what (A, B, C).
def answer : Bool × Bool × Bool := sorry

theorem answer_unique :
    island answer.1 answer.2.1 answer.2.2 = true ∧
      ∀ a b c : Bool, island a b c = true → (a, b, c) = answer := by
  sorry
