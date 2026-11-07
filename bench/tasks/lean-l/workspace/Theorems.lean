def sumTo : Nat → Nat
  | 0 => 0
  | n + 1 => sumTo n + (n + 1)

theorem sumTo_eq (n : Nat) : 2 * sumTo n = n * (n + 1) := by
  sorry

def myRev {α : Type} : List α → List α
  | [] => []
  | x :: xs => myRev xs ++ [x]

theorem myRev_append {α : Type} (l m : List α) : myRev (l ++ m) = myRev m ++ myRev l := by
  sorry

theorem myRev_myRev {α : Type} (l : List α) : myRev (myRev l) = l := by
  sorry

theorem sq_le_two_pow (n : Nat) (h : 4 ≤ n) : n * n ≤ 2 ^ n := by
  sorry

-- Four runners finish a race in distinct places 0..3 (0 is first).
-- Ann finished ahead of Bo. Cy finished exactly two places behind Ann.
-- Di was not last, and Bo was not directly behind Ann.
def race (ann bo cy di : Fin 4) : Bool :=
  ann != bo && ann != cy && ann != di && bo != cy && bo != di && cy != di &&
  ann.val < bo.val && cy.val = ann.val + 2 && di.val != 3 && bo.val != ann.val + 1

-- Fill in the finishing places (Ann, Bo, Cy, Di).
def placing : Fin 4 × Fin 4 × Fin 4 × Fin 4 := sorry

theorem placing_unique :
    race placing.1 placing.2.1 placing.2.2.1 placing.2.2.2 = true ∧
      ∀ a b c d : Fin 4, race a b c d = true → (a, b, c, d) = placing := by
  sorry
