#include <ida/ida.h>
#include <nvector/nvector_serial.h>
#include <sundials/sundials_config.h>
#include <sundials/sundials_context.h>
#include <sundials/sundials_linearsolver.h>
#include <sundials/sundials_types.h>
#include <sundials/sundials_version.h>
#include <sunlinsol/sunlinsol_klu.h>
#include <sunmatrix/sunmatrix_sparse.h>

#include <SuiteSparse_config.h>
#include <amd.h>
#include <btf.h>
#include <colamd.h>
#include <klu.h>

#include <limits.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#if SUNDIALS_VERSION_MAJOR != 7 || SUNDIALS_VERSION_MINOR != 8 ||              \
  SUNDIALS_VERSION_PATCH != 0
#error "The sparse factor probe requires SUNDIALS 7.8.0 headers"
#endif

#if !defined(SUNDIALS_DOUBLE_PRECISION) || !defined(SUNDIALS_INT64_T)
#error "The sparse factor probe requires double precision and 64-bit indices"
#endif

#if !defined(SUNDIALS_KLU_ENABLED)
#error "The sparse factor probe requires an explicitly KLU-enabled SUNDIALS"
#endif

#if SUITESPARSE_MAIN_VERSION != 7 || SUITESPARSE_SUB_VERSION != 7 ||           \
  SUITESPARSE_SUBSUB_VERSION != 0
#error "The sparse factor probe requires SuiteSparse_config 7.7.0"
#endif

#if KLU_MAIN_VERSION != 2 || KLU_SUB_VERSION != 3 || KLU_SUBSUB_VERSION != 3
#error "The sparse factor probe requires KLU 2.3.3"
#endif

_Static_assert(sizeof(sunrealtype) == sizeof(double),
               "sunrealtype must have the double ABI");
_Static_assert(sizeof(sunindextype) * CHAR_BIT == 64,
               "sunindextype must have the 64-bit ABI");
_Static_assert(sizeof(SuiteSparse_long) * CHAR_BIT == 64,
               "SuiteSparse_long must have the 64-bit ABI");

static int exact_version(void (*version_fn)(int[3]), int major, int minor,
                         int patch)
{
  int version[3] = {-1, -1, -1};
  version_fn(version);
  return version[0] == major && version[1] == minor && version[2] == patch;
}

int main(void)
{
  static const sunindextype dimension = 2;
  static const sunindextype nonzeros = 4;
  static const double tolerance = 1.0e-13;

  SUNContext context = NULL;
  N_Vector right_hand_side = NULL;
  N_Vector solution = NULL;
  SUNMatrix matrix = NULL;
  SUNLinearSolver solver = NULL;
  void* ida_memory = NULL;
  char sundials_version[32] = {0};
  int suitesparse_version[3] = {-1, -1, -1};
  int status = EXIT_FAILURE;

  if (SUNDIALSGetVersion(sundials_version, (int)sizeof(sundials_version)) !=
        SUN_SUCCESS ||
      strcmp(sundials_version, "7.8.0") != 0)
  {
    fputs("SUNDIALS runtime version mismatch\n", stderr);
    goto cleanup;
  }
  if (SuiteSparse_version(suitesparse_version) != SUITESPARSE_VERSION ||
      suitesparse_version[0] != 7 || suitesparse_version[1] != 7 ||
      suitesparse_version[2] != 0 ||
      !exact_version(klu_version, 2, 3, 3) ||
      !exact_version(amd_version, 3, 3, 2) ||
      !exact_version(colamd_version, 3, 3, 3) ||
      !exact_version(btf_version, 2, 3, 2))
  {
    fputs("SuiteSparse component runtime version mismatch\n", stderr);
    goto cleanup;
  }

  if (SUNContext_Create(SUN_COMM_NULL, &context) != SUN_SUCCESS ||
      context == NULL)
  {
    fputs("SUNContext_Create failed\n", stderr);
    goto cleanup;
  }
  right_hand_side = N_VNew_Serial(dimension, context);
  solution = N_VNew_Serial(dimension, context);
  matrix = SUNSparseMatrix(dimension, dimension, nonzeros, SUN_CSC_MAT, context);
  if (right_hand_side == NULL || solution == NULL || matrix == NULL)
  {
    fputs("serial vector or sparse matrix construction failed\n", stderr);
    goto cleanup;
  }

  sunindextype* pointers = SUNSparseMatrix_IndexPointers(matrix);
  sunindextype* indices = SUNSparseMatrix_IndexValues(matrix);
  sunrealtype* values = SUNSparseMatrix_Data(matrix);
  sunrealtype* rhs = N_VGetArrayPointer(right_hand_side);
  sunrealtype* x = N_VGetArrayPointer(solution);
  if (pointers == NULL || indices == NULL || values == NULL || rhs == NULL ||
      x == NULL)
  {
    fputs("sparse matrix or vector storage is unavailable\n", stderr);
    goto cleanup;
  }

  /* Column-major representation of [[4, 1], [2, 3]]. */
  pointers[0] = 0;
  pointers[1] = 2;
  pointers[2] = 4;
  indices[0] = 0;
  indices[1] = 1;
  indices[2] = 0;
  indices[3] = 1;
  values[0] = 4.0;
  values[1] = 2.0;
  values[2] = 1.0;
  values[3] = 3.0;
  rhs[0] = 1.0;
  rhs[1] = 1.0;
  x[0] = 0.0;
  x[1] = 0.0;

  solver = SUNLinSol_KLU(solution, matrix, context);
  if (solver == NULL || SUNLinSolGetID(solver) != SUNLINEARSOLVER_KLU)
  {
    fputs("SUNLinSol_KLU did not create the KLU implementation\n", stderr);
    goto cleanup;
  }
  if (SUNLinSol_KLUSetOrdering(solver, SUNKLU_ORDERING_DEFAULT) != SUN_SUCCESS ||
      SUNLinSolInitialize(solver) != SUN_SUCCESS ||
      SUNLinSolSetup(solver, matrix) != SUN_SUCCESS ||
      SUNLinSolSolve(solver, matrix, solution, right_hand_side, 0.0) !=
        SUN_SUCCESS)
  {
    fputs("KLU initialize, factor, or solve failed\n", stderr);
    goto cleanup;
  }
  if (fabs(x[0] - 0.2) > tolerance || fabs(x[1] - 0.2) > tolerance)
  {
    fprintf(stderr, "KLU solution mismatch: %.17g %.17g\n", (double)x[0],
            (double)x[1]);
    goto cleanup;
  }

  ida_memory = IDACreate(context);
  if (ida_memory == NULL)
  {
    fputs("IDACreate failed\n", stderr);
    goto cleanup;
  }
  status = EXIT_SUCCESS;

cleanup:
  if (ida_memory != NULL) { IDAFree(&ida_memory); }
  if (solver != NULL) { (void)SUNLinSolFree(solver); }
  if (matrix != NULL) { SUNMatDestroy(matrix); }
  if (solution != NULL) { N_VDestroy(solution); }
  if (right_hand_side != NULL) { N_VDestroy(right_hand_side); }
  if (context != NULL) { (void)SUNContext_Free(&context); }

  if (status == EXIT_SUCCESS)
  {
    puts("SUNDIALS 7.8.0 IDA + SuiteSparse 7.7.0 KLU sparse factor/solve "
         "probe passed");
  }
  return status;
}
